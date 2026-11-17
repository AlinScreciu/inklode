//! The MCP server inside the running app, so an agent can drive and inspect the real window.
//!
//! Every request must carry the token of `token` as `Authorization: Bearer <token>`, or it gets a 401.
//! The token is a file in the app's config folder that only the user can read, so another user of
//! this computer, and a program that cannot read the user's files, cannot drive the app. It is never
//! given to the window: the Copy buttons of the settings screen put it on the clipboard from here
//! (`mcp_copy`), so no tool of this server, `ui_state` included, can return it.
//!
//! It serves MCP over streamable HTTP on `127.0.0.1` and offers:
//! - the core tools from `inklode_mcp`, run on the same `Core` the window uses;
//! - the UI tools in `ui_tools`, which the webview answers (see `ui_request`);
//! - `ui_screenshot`, answered here (macOS only).

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use inklode_core::Core;
use hyper_util::rt::TokioIo;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};

pub const DEFAULT_PORT: u16 = 7811;

/// How long the window gets to answer a UI request or take a screenshot.
// shortcut: one fixed limit, so a UI command that runs longer (a rename across a huge vault,
// `vault.open` without a path waiting on the folder dialog) reports a timeout although it
// continues in the window; add a per-call timeout argument if that gets in the way.
const UI_TIMEOUT: Duration = Duration::from_secs(5);

type UiAnswer = Result<Value, String>;

/// The UI requests that are waiting for the webview's `ui_reply`, by request id.
#[derive(Default)]
pub struct UiBridge {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<UiAnswer>>>,
}

/// The webview's answer to a `ui-request` event: `result` on success, `error` if it threw.
#[tauri::command]
pub fn ui_reply(window: tauri::WebviewWindow, bridge: tauri::State<'_, UiBridge>, id: u64, result: Option<Value>, error: Option<String>) {
    // Requests go to the main window's UI, so only it answers.
    if crate::main_only(&window).is_err() {
        return;
    }
    // An unknown id is an answer that came after the timeout. Nobody is waiting for it.
    if let Some(waiting) = bridge.pending.lock().unwrap().remove(&id) {
        let _ = waiting.send(match error {
            Some(error) => Err(error),
            None => Ok(result.unwrap_or(Value::Null)),
        });
    }
}

/// Asks the webview to do `kind` with `args` and waits for its answer.
/// It sends the Tauri event `ui-request` `{id, kind, args}`; the UI handles it in `App.tsx`.
async fn ui_request(app: &AppHandle, kind: &str, args: Value) -> UiAnswer {
    let bridge = app.state::<UiBridge>();
    let id = bridge.next_id.fetch_add(1, Ordering::Relaxed);
    let (sender, answer) = oneshot::channel();
    bridge.pending.lock().unwrap().insert(id, sender);
    let answer = match app.emit("ui-request", json!({ "id": id, "kind": kind, "args": args })) {
        Err(error) => Err(error.to_string()),
        Ok(()) => match tokio::time::timeout(UI_TIMEOUT, answer).await {
            Ok(Ok(answer)) => answer,
            _ => Err(format!("the window did not answer within {} s", UI_TIMEOUT.as_secs())),
        },
    };
    bridge.pending.lock().unwrap().remove(&id);
    answer
}

/// The tools the webview answers. The tool name is the `kind` of the UI request
/// and the arguments are passed on unchanged.
fn ui_tools() -> Vec<Tool> {
    let tool = |name: &'static str, description: &'static str, properties: Value, required: &[&str]| {
        let schema = json!({ "type": "object", "properties": properties, "required": required });
        Tool::new(name, description, rmcp::model::object(schema))
    };
    vec![
        tool(
            "command_list",
            "Lists the commands of the app window (the same ones as in its command palette) as [{id, title, key?}].",
            json!({}),
            &[],
        ),
        tool(
            "command_run",
            "Runs one command in the app window, as the palette or its shortcut would. Returns null, or a tool error with the message if the command failed. `claims.check`, `claims.checkAll` and `claims.trust` are refused: those are the user's to run. Without params, `vault.open`, `note.new` and `note.rename` open a dialog and wait for the user; pass {path} to run them directly.",
            json!({
                "id": { "type": "string", "description": "Command id from `command_list`, e.g. `note.new`." },
                "params": { "type": "object", "description": "Parameters for the command. `vault.open`: {path} absolute folder. `note.new`: {path} of the new note. `note.rename`: {path} new path of the open note." },
            }),
            &["id"],
        ),
        tool(
            "ui_state",
            "Describes what the app window shows: vault, open note with the editor's text (first 20000 characters) and cursor line, whether sidebar, search and a dialog are open, the visible file-tree entries, the backlinks and search results shown, the error banner, and `viewport` {width, height, devicePixelRatio} in CSS pixels.",
            json!({}),
            &[],
        ),
        tool(
            "ui_open",
            "Opens a note in the app window, like clicking it in the file tree.",
            json!({
                "path": { "type": "string", "description": "Path of the note, relative to the vault root, with forward slashes." },
                "line": { "type": "integer", "description": "Line to put the cursor on, starting at 1." },
            }),
            &["path"],
        ),
        // The three below send DOM events in the webview (src/uiDrive.ts). They are not trusted events,
        // which is why the descriptions exclude what needs a real user gesture.
        tool(
            "ui_click",
            "Clicks at a point of the app window: pointer and mouse down and up, then click, on the element at that point, which gets the focus as on a real click. Checkboxes, radio buttons, links and buttons react; the popup of a select, file pickers and the clipboard do not. Coordinates are CSS pixels from the top left of the window's content. `ui_screenshot` pixels are larger: divide them by `viewport.devicePixelRatio` from `ui_state`. Returns the element that was hit as {tag, id?, classes?, text} (text: first 80 characters).",
            json!({
                "x": { "type": "number", "description": "CSS pixels from the left edge." },
                "y": { "type": "number", "description": "CSS pixels from the top edge." },
                "button": { "type": "string", "enum": ["left", "middle", "right"], "description": "Default left. Right sends `contextmenu` and middle `auxclick` instead of `click`." },
                "count": { "type": "integer", "enum": [1, 2], "description": "2 for a double click. Default 1." },
                "mod": { "type": "boolean", "description": "Hold Cmd on macOS, Ctrl elsewhere: on a link in a note or a file in the tree, opens it in a new tab." },
            }),
            &["x", "y"],
        ),
        tool(
            "ui_drag",
            "Drags with the left mouse button in the app window: down at `from`, `steps` moves along the straight line, up at `to`, with a short pause after each so the app can react. Selects text in the editor and draws on a canvas; does not start an HTML drag-and-drop. Coordinates as for `ui_click`: CSS pixels, so divide `ui_screenshot` pixels by `viewport.devicePixelRatio` from `ui_state`. Returns the element that was hit at `from` as {tag, id?, classes?, text}.",
            json!({
                "from": { "type": "object", "description": "Where the button goes down.", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] },
                "to": { "type": "object", "description": "Where the button is released.", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] },
                "steps": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Number of moves between the two points. Default 10." },
            }),
            &["from", "to"],
        ),
        tool(
            "ui_key",
            "Sends keyboard input to the focused element of the app window (click it first with `ui_click`). With `key`: one key press (keydown and keyup), which runs shortcuts such as {key: \"p\", mod: true} or {key: \"Escape\"} but types nothing, also for a letter. With `text` instead of `key`: types that text at the cursor, replacing the selection. Returns the focused element as {tag, id?, classes?, text}.",
            json!({
                "key": { "type": "string", "description": "The key as in the DOM `KeyboardEvent.key`: `Enter`, `Escape`, `ArrowRight`, `Backspace`, `a`." },
                "mod": { "type": "boolean", "description": "Hold Cmd on macOS, Ctrl elsewhere." },
                "shift": { "type": "boolean", "description": "Hold Shift." },
                "alt": { "type": "boolean", "description": "Hold Alt (Option on macOS)." },
                "text": { "type": "string", "description": "Text to type. Used when `key` is not given." },
            }),
            &[],
        ),
    ]
}

/// Why `command_run` does not run the command `id`, for the commands that are the user's alone:
/// checking a claim can run a command a note names, and trusting a vault allows that.
fn users_alone(id: &str) -> Option<&'static str> {
    // The window looks a command up by its exact id, so these three spellings are all there is to refuse.
    matches!(id, "claims.check" | "claims.checkAll" | "claims.trust")
        .then_some("claims are checked, and a vault is trusted for commands, by the user in the app: this command cannot be run over MCP")
}

fn screenshot_tool() -> Tool {
    let schema = json!({ "type": "object", "properties": {} });
    Tool::new("ui_screenshot", "Returns a PNG image of the app window's content. Its pixels are device pixels: divide a position in it by `viewport.devicePixelRatio` from `ui_state` to get the coordinates `ui_click` and `ui_drag` take.", rmcp::model::object(schema))
}

#[derive(Clone)]
struct Server {
    app: AppHandle,
}

impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Tools over the running Inklode app. search, read, write, rename, list, backlinks and resolve act on the vault open in the window; paths are relative to the vault root and use forward slashes. command_* and ui_* drive and inspect the window itself.",
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut tools = inklode_mcp::tools();
        tools.extend(ui_tools());
        if cfg!(target_os = "macos") {
            tools.push(screenshot_tool());
        }
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.to_string();
        let params = Value::Object(request.arguments.unwrap_or_default());
        let error = |message: String| CallToolResult::error(vec![ContentBlock::text(message)]);

        #[cfg(target_os = "macos")]
        if name == "ui_screenshot" {
            return Ok(match screenshot(&self.app).await {
                Ok(png) => {
                    use base64::Engine;
                    let data = base64::engine::general_purpose::STANDARD.encode(png);
                    CallToolResult::success(vec![ContentBlock::image(data, "image/png")])
                }
                Err(message) => error(message),
            }
            .into());
        }

        if name == "command_run" {
            if let Some(why) = params["id"].as_str().and_then(users_alone) {
                return Ok(error(why.to_string()).into());
            }
        }

        if ui_tools().iter().any(|tool| tool.name == name) {
            return Ok(match ui_request(&self.app, &name, params).await {
                Ok(value) => CallToolResult::success(vec![ContentBlock::text(value.to_string())]),
                Err(message) => error(message),
            }
            .into());
        }

        // Core calls block on the disk and on the core's lock, so they run off the async runtime.
        let app = self.app.clone();
        let tool = name.clone();
        let ran = tauri::async_runtime::spawn_blocking(move || {
            inklode_mcp::call(&app.state::<Arc<Mutex<Core>>>(), &tool, params)
        })
        .await;
        match ran {
            Ok(Some(result)) => Ok(result.into()),
            Ok(None) => Err(ErrorData::invalid_params(format!("unknown tool: {name}"), None)),
            Err(panicked) => Ok(error(panicked.to_string()).into()),
        }
    }
}

/// A PNG of the webview's content, taken by WebKit itself, so it needs no Screen Recording permission.
#[cfg(target_os = "macos")]
async fn screenshot(app: &AppHandle) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    fn png(image: &NSImage) -> Option<Vec<u8>> {
        let tiff = image.TIFFRepresentation()?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
        // SAFETY: an empty properties dictionary is valid for every file type.
        let png = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
        Some(png.to_vec())
    }

    let window = app.get_webview_window("main").ok_or("the app has no window")?;
    let (sender, taken) = oneshot::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |webview| {
            // The block may be called only once, but its type is `Fn`, so the sender sits in a cell.
            let sender = std::cell::Cell::new(Some(sender));
            let done = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                // SAFETY: WebKit passes either a valid image or a valid error, the other is null.
                let result = match unsafe { (image.as_ref(), error.as_ref()) } {
                    (Some(image), _) => png(image).ok_or_else(|| "could not encode the snapshot as PNG".to_string()),
                    (None, Some(error)) => Err(error.localizedDescription().to_string()),
                    (None, None) => Err("WebKit returned no snapshot".to_string()),
                };
                if let Some(sender) = sender.take() {
                    let _ = sender.send(result);
                }
            });
            // SAFETY: on macOS `inner` is the window's WKWebView, and this closure runs on the main thread.
            unsafe {
                let view: &WKWebView = &*webview.inner().cast();
                view.takeSnapshotWithConfiguration_completionHandler(None, &done);
            }
        })
        .map_err(|e| e.to_string())?;
    match tokio::time::timeout(UI_TIMEOUT, taken).await {
        Ok(Ok(result)) => result,
        _ => Err(format!("no snapshot within {} s", UI_TIMEOUT.as_secs())),
    }
}

/// The file the token is kept in, in the app's config folder: never in a vault.
fn token_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("mcp-token"))
}

/// The token in the file at `path`, if it holds one: 64 hex digits. The file is made readable by its owner alone if it was not.
fn read_token(path: &Path) -> Option<String> {
    let token = std::fs::read_to_string(path).ok()?.trim().to_string();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    (token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())).then_some(token)
}

/// Writes a new random token to the file at `path`, readable by its owner alone, and returns it.
fn write_token(path: &Path) -> Result<String, String> {
    let failed = |e: std::io::Error| format!("{}: {e}", path.display());
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("no random numbers for the MCP token: {e}"))?;
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    // Through a temporary file and a rename, like the settings file. The mode is set when the
    // file is made, so the token is at no time in a file others can read.
    let tmp = path.with_extension("inklode-tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::File::options();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&tmp).map_err(failed)?;
    std::io::Write::write_all(&mut file, format!("{token}\n").as_bytes()).map_err(failed)?;
    std::fs::rename(&tmp, path).map_err(failed)?;
    Ok(token)
}

/// The token of the MCP server: the one in the file, or a new one, made when there is none yet.
pub fn token(app: &AppHandle) -> Result<String, String> {
    let path = token_file(app)?;
    match read_token(&path) {
        Some(token) => Ok(token),
        None => write_token(&path),
    }
}

/// Whether two byte strings are equal, in a time that does not depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |differ, (a, b)| differ | (a ^ b)) == 0
}

/// Whether a request with these headers carries `token`: `Authorization: Bearer <token>`. No request does while there is no token.
fn authorized(headers: &hyper::HeaderMap, token: &str) -> bool {
    let sent = headers.get(hyper::header::AUTHORIZATION).and_then(|value| value.to_str().ok()).and_then(|value| value.split_once(' '));
    !token.is_empty() && sent.is_some_and(|(scheme, sent)| scheme.eq_ignore_ascii_case("Bearer") && same(sent.trim().as_bytes(), token.as_bytes()))
}

/// Whether a request with these headers may in: it carries the token that is in the file now. The file is
/// read for every request, so a new token counts at once, also one made by another running copy of the app,
/// and without the file no request gets in.
fn allows(app: &AppHandle, headers: &hyper::HeaderMap) -> bool {
    let token = token_file(app).ok().and_then(|path| read_token(&path));
    token.is_some_and(|token| authorized(headers, &token))
}

/// The line that registers this server with Claude Code.
fn add_command(port: u16, token: &str) -> String {
    format!("claude mcp add --transport http inklode-app http://127.0.0.1:{port}/mcp --header \"Authorization: Bearer {token}\"")
}

/// Puts the token (`what`: `token`) or the `claude mcp add` line with it (`command`) on the clipboard, for the
/// Copy buttons of the settings screen. Nothing of it is returned: the window never has the token.
/// `port` is the one the line names: the settings screen knows which the server runs on, or would.
#[tauri::command]
pub fn mcp_copy(window: tauri::WebviewWindow, app: AppHandle, what: String, port: u16) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    crate::main_only(&window)?;
    let token = token(&app)?;
    let text = match what.as_str() {
        "token" => token,
        "command" => add_command(port, &token),
        _ => return Err("what must be `token` or `command`".into()),
    };
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// Replaces the token with a new one, for the "New token" button. Every client needs the new one from then on.
#[tauri::command]
pub fn mcp_token_new(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    crate::main_only(&window)?;
    write_token(&token_file(&app)?).map(drop)
}

/// The port to serve on, or `Ok(None)` when the server is off. `file` is the port from the
/// settings file if the server is enabled there. `env` is the value of `INKLODE_MCP_PORT`;
/// when set and not empty it wins: a port number forces the server on, `off` forces it off.
pub fn port(env: Option<&str>, file: Option<u16>) -> Result<Option<u16>, String> {
    match env {
        None | Some("") => Ok(file),
        Some("off") => Ok(None),
        Some(text) => match text.parse() {
            Ok(port) if port != 0 => Ok(Some(port)),
            _ => Err(format!("INKLODE_MCP_PORT must be a port number or `off`, not `{text}`")),
        },
    }
}

/// The server while it listens. `stop` ends it.
pub struct Running {
    pub port: u16,
    stop: watch::Sender<()>,
    accepting: tauri::async_runtime::JoinHandle<()>,
}

impl Running {
    /// Stops accepting connections and returns when the port is free again. A request
    /// that is being answered still gets its answer; then its connection is closed.
    pub async fn stop(self) {
        drop(self.stop);
        let _ = self.accepting.await;
    }
}

/// Starts the MCP server on `port` and returns once it listens, or the reason it cannot.
/// It does not start without a token.
pub async fn start(app: &AppHandle, port: u16) -> Result<Running, String> {
    token(app).map_err(|error| format!("no token for the MCP server: {error}"))?;
    // Loopback only: the server is not reachable from other machines.
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|error| format!("could not listen on 127.0.0.1:{port}: {error}"))?;
    // A web page open in the user's browser can also send requests to 127.0.0.1.
    // Browsers put an `Origin` header on those, so every request that has one is refused,
    // and the exact `Host` check stops DNS rebinding (a foreign name that resolves to 127.0.0.1).
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts([format!("127.0.0.1:{port}"), format!("localhost:{port}")])
        .enforce_origin_validation()
        // No sessions: every request stands alone and gets a plain JSON response.
        .with_legacy_session_mode(false)
        .with_json_response(true);
    let token_app = app.clone();
    let app = app.clone();
    let service = StreamableHttpService::new(
        move || Ok(Server { app: app.clone() }),
        Arc::new(NeverSessionManager::default()),
        config,
    );
    // Dropping `stop` wakes every `changed()` below.
    let (stop, stopped) = watch::channel(());
    let accepting = tauri::async_runtime::spawn(async move {
        let mut stopping = stopped.clone();
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = stopping.changed() => return,
            };
            let Ok((stream, _)) = accepted else {
                // E.g. out of file descriptors. Wait instead of spinning.
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            let service = service.clone();
            let service_app = token_app.clone();
            let mut stopped = stopped.clone();
            tokio::spawn(async move {
                let serve = hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                    let service = service.clone();
                    // Asked per request, so a new token counts from the next request on.
                    let allowed = allows(&service_app, request.headers());
                    async move { Ok::<_, Infallible>(if allowed { service.handle(request).await } else { unauthorized() }) }
                });
                let connection = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), serve);
                tokio::pin!(connection);
                // An error here is a client that went away.
                tokio::select! {
                    _ = connection.as_mut() => {}
                    _ = stopped.changed() => {
                        // Finish the request in hand, then close, so a kept-alive
                        // connection cannot go on using a server that is switched off.
                        connection.as_mut().graceful_shutdown();
                        let _ = connection.await;
                    }
                }
            });
        }
    });
    Ok(Running { port, stop, accepting })
}

/// The answer to a request without the token.
fn unauthorized() -> hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, Infallible>> {
    use http_body_util::BodyExt;
    let body = "The Inklode MCP server needs its token: send `Authorization: Bearer <token>`. Copy the token, or the whole `claude mcp add` line, in Settings > MCP server.\n";
    hyper::Response::builder()
        .status(hyper::StatusCode::UNAUTHORIZED)
        .header(hyper::header::WWW_AUTHENTICATE, "Bearer")
        .header(hyper::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(http_body_util::Full::new(bytes::Bytes::from_static(body.as_bytes())).boxed())
        .expect("a fixed response is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_made_once_in_a_file_only_its_owner_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config/mcp-token");
        assert_eq!(read_token(&path), None);
        let token = write_token(&path).unwrap();
        assert!(token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()), "{token}");
        assert_eq!(read_token(&path), Some(token.clone()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            // A file that was opened up is closed again when it is read.
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(read_token(&path), Some(token.clone()));
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // A new one is another one, and nothing but the token file is left in the folder.
        let next = write_token(&path).unwrap();
        assert_ne!(next, token);
        assert_eq!(read_token(&path), Some(next));
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        // What is not a token is not taken for one: a new one is made in its place.
        for bad in ["", "short", &"g".repeat(64)] {
            std::fs::write(&path, bad).unwrap();
            assert_eq!(read_token(&path), None, "{bad:?}");
        }
    }

    #[test]
    fn a_request_is_authorized_only_with_the_bearer_token() {
        let token = "ab".repeat(32);
        let with = |value: Option<&str>| {
            let mut headers = hyper::HeaderMap::new();
            if let Some(value) = value {
                headers.insert(hyper::header::AUTHORIZATION, value.parse().unwrap());
            }
            authorized(&headers, &token)
        };
        assert!(with(Some(&format!("Bearer {token}"))));
        assert!(with(Some(&format!("bearer {token}"))));
        let wrong = format!("Bearer {}", "ab".repeat(31) + "ac");
        for bad in [None, Some(""), Some("Bearer"), Some("Bearer "), Some(token.as_str()), Some(&format!("Basic {token}")), Some(wrong.as_str()), Some(&format!("Bearer {token}x")), Some(&format!("Bearer {}", &token[..63]))] {
            assert!(!with(bad), "{bad:?}");
        }
        // Without a token nothing is let in, not even an empty one.
        let mut headers = hyper::HeaderMap::new();
        headers.insert(hyper::header::AUTHORIZATION, "Bearer ".parse().unwrap());
        assert!(!authorized(&headers, ""));
        assert!(same(b"abc", b"abc") && !same(b"abc", b"abd") && !same(b"abc", b"ab") && same(b"", b""));

        assert_eq!(add_command(7811, "t0"), "claude mcp add --transport http inklode-app http://127.0.0.1:7811/mcp --header \"Authorization: Bearer t0\"");
        assert_eq!(unauthorized().status(), hyper::StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn command_run_refuses_the_commands_that_check_claims_or_trust_a_vault() {
        for id in ["claims.check", "claims.checkAll", "claims.trust"] {
            assert!(users_alone(id).is_some_and(|why| why.contains("by the user in the app")), "{id}");
        }
        for id in ["claims.open", "note.new", "claims", ""] {
            assert_eq!(users_alone(id), None, "{id}");
        }
    }

    #[test]
    fn port_from_settings_file_and_env() {
        // No env: the file decides.
        assert_eq!(port(None, None), Ok(None));
        assert_eq!(port(None, Some(7811)), Ok(Some(7811)));
        assert_eq!(port(Some(""), Some(7811)), Ok(Some(7811)));
        // The env wins over the file, both ways.
        assert_eq!(port(Some("off"), Some(7811)), Ok(None));
        assert_eq!(port(Some("9000"), None), Ok(Some(9000)));
        assert_eq!(port(Some("9000"), Some(7811)), Ok(Some(9000)));
        for bad in ["0", "no", "70000"] {
            assert!(port(Some(bad), Some(7811)).is_err(), "{bad}");
        }
    }
}
