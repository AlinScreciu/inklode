use std::sync::{Arc, Mutex};

use inklode_core::Core;
use serde_json::Value;
use tauri::{Emitter, Manager};

mod capture;
mod mcp;
#[cfg(target_os = "macos")]
mod menu;
mod settings;

/// The one core, shared by the window (`core_call`) and the MCP server.
pub(crate) type SharedCore = Arc<Mutex<Core>>;

/// The only bridge from the UI to the core. New operations are added in
/// `inklode_core::Core::call`, not here.
///
/// One thing is decided here and not by the caller: whether `claims.check` may run a
/// command. That is so only in a vault the user marked as trusted in the app's settings
/// (`claims_trust` in settings.rs), whatever `commands` the window sends.
// `async` moves the call off the main thread, so a slow disk does not freeze the window.
#[tauri::command(async)]
fn core_call(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedCore>,
    name: String,
    params: Value,
) -> Result<Value, String> {
    main_only(&window)?;
    if name == "claims.check" {
        // The core is let go of before the check: a command may run for two minutes, and
        // the window reads and saves notes meanwhile.
        let check = state.lock().map_err(|e| e.to_string())?.claim_check().map_err(|e| e.to_string())?;
        let trusted = settings::claims_trusted(&app, check.root());
        return check.run(params, trusted).map_err(|e| e.to_string());
    }
    if name == "vault.health" {
        // Let go of in the same way: the report runs git in every repository the notes name,
        // which takes seconds, and opening or saving a note must not wait for it.
        let check = state.lock().map_err(|e| e.to_string())?.health_check().map_err(|e| e.to_string())?;
        return Ok(serde_json::json!(check.run()));
    }
    if inklode_core::Outside::has(&name) {
        // And so are the `git.*` and `review.*` operations: they run git and compare every note with a
        // commit, after each save and each change on disk, and use nothing of the core but the vault's folder.
        let outside = state.lock().map_err(|e| e.to_string())?.outside().map_err(|e| e.to_string())?;
        return outside.run(&name, params).map_err(|e| e.to_string());
    }
    let mut core = state.lock().map_err(|e| e.to_string())?;
    let result = core.call(&name, params).map_err(|e| e.to_string())?;
    // The window may load files (images in notes) from the open vault, and from nowhere else.
    // shortcut: a vault opened earlier in this run stays loadable until the app quits;
    // forbid the old root here if switching vaults has to revoke it
    if name == "vault.open" {
        if let Some(root) = result["root"].as_str() {
            app.asset_protocol_scope().allow_directory(root, true).map_err(|e| e.to_string())?;
        }
        // The capture hotkey belongs to the vaults that have it on in the app's settings: asked again for this one.
        let app = app.clone();
        tauri::async_runtime::spawn(async move { capture::apply(&app).await });
    }
    Ok(result)
}

/// The app's commands are for the main window. Tauri lets every window call them, and the presenter window
/// (below) shows file content, so it must not reach the vault, the settings or the MCP bridge.
pub(crate) fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("only the main window may call this".into()) }
}

/// Opens the presenter window of a slideshow: the same UI bundle at `#presenter`, which draws only the presenter
/// view (src/modules/excalidraw/Presenter.tsx). It is in no capability, so it has no Tauri permission at all, and
/// it talks to the main window over a `BroadcastChannel`. If it is already open, it comes to the front.
// shortcut: with a second display it opens there, at that display's top left, in a window; choosing the display,
// remembering the choice and going fullscreen there wait until presenting on two displays is used for real
#[tauri::command]
async fn presenter_open(window: tauri::WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    let app = window.app_handle();
    if let Some(open) = app.get_webview_window("presenter") {
        return open.set_focus().map_err(|e| e.to_string());
    }
    let mut builder = tauri::WebviewWindowBuilder::new(app, "presenter", tauri::WebviewUrl::App("index.html#presenter".into()))
        .title("Inklode presenter")
        .inner_size(1100.0, 720.0)
        .min_inner_size(640.0, 420.0);
    // A display other than the one the slides are on, when there is one. Else where the system puts a new window.
    let here = window.current_monitor().ok().flatten().map(|monitor| *monitor.position());
    let monitors = window.available_monitors().unwrap_or_default();
    if let Some(other) = monitors.iter().find(|monitor| Some(*monitor.position()) != here) {
        let at = other.position().to_logical::<f64>(other.scale_factor());
        builder = builder.position(at.x + 60.0, at.y + 60.0);
    }
    let presenter = builder.build().map_err(|e| e.to_string())?;
    // The main window's UI is told when it is gone: a webview does not reliably say so itself when its window closes.
    let app = app.clone();
    presenter.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let _ = app.emit_to("main", "presenter-closed", ());
        }
    });
    Ok(())
}

/// Closes the presenter window, if it is open.
#[tauri::command]
fn presenter_close(window: tauri::WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    match window.app_handle().get_webview_window("presenter") {
        Some(open) => open.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Opens the system's print dialog on the main window's page, for "Export to PDF" (src/print.ts), whose print
/// styles show only the note. Tauri's own `print` sets the paper's margins to nothing, so the text would touch
/// the edge of every page; here each margin is `PRINT_MARGIN`, which the dialog can still change.
#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    #[cfg(target_os = "macos")]
    return window
        .with_webview(|webview| {
            use objc2_app_kit::NSPrintInfo;
            use objc2_web_kit::WKWebView;
            /// 18 mm, in points.
            const PRINT_MARGIN: f64 = 51.0;
            let info = NSPrintInfo::sharedPrintInfo();
            info.setTopMargin(PRINT_MARGIN);
            info.setBottomMargin(PRINT_MARGIN);
            info.setLeftMargin(PRINT_MARGIN);
            info.setRightMargin(PRINT_MARGIN);
            // SAFETY: on macOS `inner` is the window's WKWebView, and this closure runs on the main thread. The
            // print operation runs as a sheet on the window, with no delegate.
            unsafe {
                let view: &WKWebView = &*webview.inner().cast();
                let operation = view.printOperationWithPrintInfo(&info);
                // The page is laid out for print on another thread, so the window keeps answering.
                operation.setCanSpawnSeparateThread(true);
                if let Some(on) = view.window() {
                    operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(&on, None, None, std::ptr::null_mut());
                }
            }
        })
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    window.print().map_err(|e| e.to_string())
}

/// Ends the app. The UI calls it from its `app.quit` command, after it wrote what was unsaved.
#[tauri::command]
fn app_quit(window: tauri::WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    window.app_handle().exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Takes `PATH` from the user's login shell. An app started from the Dock or Finder gets only
/// `/usr/bin:/bin:/usr/sbin:/sbin`, so a claim's command (`cargo test`) or git from Homebrew would
/// not be found. Started from a terminal the answer is the same `PATH` it already has.
#[cfg(unix)]
fn path_from_shell() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // Interactive too, because tools like nvm add themselves in `.zshrc`; the markers cut off
    // whatever the shell's startup files print.
    // shortcut: waits for the shell with no time limit, add one if a startup file can hang
    let output = std::process::Command::new(shell)
        .args(["-ilc", "printf '<inklode-path>%s</inklode-path>' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    let Ok(output) = output else { return };
    let text = String::from_utf8_lossy(&output.stdout);
    let path = text.split("<inklode-path>").nth(1).and_then(|rest| rest.split("</inklode-path>").next());
    if let Some(path) = path.filter(|path| !path.is_empty()) {
        // Safe here: `run` calls this first, before any other thread exists.
        unsafe { std::env::set_var("PATH", path) };
    }
}

/// Whether `url` is a page of the app itself: the bundled UI (`tauri://localhost`, on Windows
/// `http(s)://tauri.localhost`), in a development build also the dev server at `dev`, and the empty
/// page a window starts with. The app's windows go nowhere else (`run`).
fn own_page(url: &tauri::Url, dev: Option<&tauri::Url>) -> bool {
    let origin = |url: &tauri::Url| (url.scheme().to_string(), url.host_str().map(str::to_string), url.port_or_known_default());
    matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")))
        || dev.is_some_and(|dev| origin(dev) == origin(url))
        || url.as_str() == "about:blank"
}

pub fn run() {
    #[cfg(unix)]
    path_from_shell();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // No window of the app leaves the app's own page: a link in a note or a drawing that the UI did not
        // handle must not put a web page where the app was, with the app's permissions. Web addresses are
        // opened in the browser by the UI (`openExternal`).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("own-pages")
                .on_navigation(|webview, url| {
                    let dev = if cfg!(dev) { webview.app_handle().config().build.dev_url.clone() } else { None };
                    let own = own_page(url, dev.as_ref());
                    if !own {
                        eprintln!("inklode: refused to navigate the window {} to {url}", webview.label());
                    }
                    own
                })
                .build(),
        )
        // For `mcp_copy` alone. The window has no permission for the clipboard.
        .plugin(tauri_plugin_clipboard_manager::init())
        // Updates: the window asks for a check and for the install (`checkForUpdate` in src/core/client.ts).
        // The updater itself refuses an archive that is not signed with the key whose public half is in tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // For the restart after an update is installed.
        .plugin(tauri_plugin_process::init())
        // The hotkey of quick capture, the only global shortcut: registered and unregistered in capture.rs.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        // Off the main thread, which this is: making the box's window waits for it.
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = capture::open(&app) {
                                eprintln!("inklode: the capture box did not open: {error}");
                            }
                        });
                    }
                })
                .build(),
        )
        .manage(SharedCore::default())
        .manage(mcp::UiBridge::default())
        .manage(settings::McpState::default())
        .manage(capture::CaptureState::default())
        // The main window's UI starts again (a reload) and knows nothing of what the page before it asked for:
        // the capture hotkey goes, until the UI says again that the open vault has the module on.
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
                let app = webview.app_handle().clone();
                tauri::async_runtime::spawn(async move { capture::enable(&app, false).await });
            }
        })
        .setup(|app| {
            // Every event from the core goes to the UI as a `core-event`.
            let handle = app.handle().clone();
            let core = app.state::<SharedCore>();
            core.lock().unwrap().set_listener(move |event| {
                let _ = handle.emit("core-event", event);
            });
            // What the user has reviewed is kept next to the app's settings.json, outside every vault.
            // `inklode-mcp` names the same folder (`state_dir` in crates/mcp/src/main.rs).
            match app.path().app_config_dir() {
                Ok(dir) => core.lock().unwrap().set_state_dir(dir),
                Err(error) => eprintln!("inklode: no state folder, so review is not available: {error}"),
            }
            // Starts the MCP server if the settings say so. It waits for the bind,
            // so the first `app_settings_get` already has the true status.
            let status = tauri::async_runtime::block_on(settings::apply(app.handle()));
            if let Some(error) = status["mcpStatus"]["error"].as_str() {
                eprintln!("inklode: MCP server not started: {error}");
            }
            // The app works without its menu (the keys are also handled in the window), so a failure is only reported.
            #[cfg(target_os = "macos")]
            if let Err(error) = menu::install(app.handle()) {
                eprintln!("inklode: no menu bar: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_call,
            settings::app_settings_get,
            settings::app_settings_set,
            settings::claims_trust,
            settings::capture_set,
            settings::updates_set,
            mcp::ui_reply,
            mcp::mcp_copy,
            mcp::mcp_token_new,
            presenter_open,
            presenter_close,
            print_page,
            capture::capture_enable,
            capture::capture_open,
            capture::capture_done,
            app_quit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_stays_on_the_apps_own_pages() {
        let url = |text: &str| tauri::Url::parse(text).unwrap();
        let dev = url("http://localhost:1420");
        for own in ["tauri://localhost", "tauri://localhost/index.html#presenter", "http://tauri.localhost/", "https://tauri.localhost/index.html#capture", "about:blank"] {
            assert!(own_page(&url(own), None), "{own}");
        }
        assert!(own_page(&url("http://localhost:1420/index.html#capture"), Some(&dev)));
        let elsewhere = [
            "https://example.com/",
            "http://localhost:1420/",
            "http://localhost:8000/",
            "tauri://evil/",
            "https://tauri.localhost.evil.com/",
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "about:srcdoc",
            "blob:tauri://localhost/1234",
        ];
        for other in elsewhere {
            assert!(!own_page(&url(other), None), "{other}");
        }
        // In a development build the dev server is the app, on its port only.
        assert!(!own_page(&url("http://localhost:8000/"), Some(&dev)) && !own_page(&url("https://localhost:1420/"), Some(&dev)));
    }
}
