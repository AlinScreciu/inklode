//! Quick capture: a system-wide hotkey that brings up a small box, whose text the main window's UI
//! appends to the vault's capture note (src/modules/capture).
//!
//! The hotkey is an app-level setting (`capture.hotkey` in the app's `settings.json`, see settings.rs), and
//! so is whether quick capture is on for a vault (`capture.vaults` there, switched by `capture_set`): never
//! a vault's, so a vault folder received from someone else cannot take a system-wide key. The hotkey is
//! registered only while the open vault is on that list and the UI has its `capture` module running
//! (`capture_enable`). What a vault's own `.inklode/settings.json` says about the module is not asked.
//!
//! The box is a window of its own, labelled `capture`, which loads the UI bundle at `#capture`
//! (src/modules/capture/Box.tsx). It is in no capability, so it has no Tauri permission, and of the app's
//! commands it may call only `capture_done`. The text goes from there to the main window as a
//! `capture-text` event, because the main window knows what is unsaved in the capture note.
//!
//! On macOS the box is a panel that takes the keyboard without making Inklode the active app (`panel`
//! below). So it shows over whatever is in front, also another app's fullscreen window, the main window
//! stays where it is, and when the box goes the app the user was in has the keyboard again.

use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+Space";

const WINDOW: &str = "capture";

#[derive(Default)]
pub struct CaptureState {
    /// One change of the registration at a time.
    applying: tokio::sync::Mutex<()>,
    registration: Mutex<Registration>,
}

#[derive(Default)]
struct Registration {
    /// Whether the UI has the `capture` module running.
    wanted: bool,
    registered: Option<Shortcut>,
    /// Why the hotkey is not registered although it should be.
    error: Option<String>,
}

/// A hotkey as written in the settings, e.g. `Ctrl+Alt+Space`: modifiers (`Ctrl`, `Alt`, `Shift`, `Cmd`), then one key.
pub fn parse(hotkey: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut =
        hotkey.trim().parse().map_err(|_| format!("{hotkey} is not a key combination: write modifiers and one key, e.g. {DEFAULT_HOTKEY}"))?;
    // A bare key would be taken away from every app, for as long as Inklode runs.
    if shortcut.mods.is_empty() {
        return Err(format!("{hotkey} has no modifier key: a global hotkey needs Ctrl, Alt, Shift or Cmd"));
    }
    Ok(shortcut)
}

/// `{registered, error}` for `app_settings_get`: whether the hotkey is registered now, and why it is not
/// although it should be.
pub fn status(app: &AppHandle) -> Value {
    let state = app.state::<CaptureState>();
    let registration = state.registration.lock().unwrap();
    json!({ "registered": registration.registered.is_some(), "error": registration.error })
}

/// Makes the registration match the settings file and whether the module is on: registers the hotkey,
/// unregisters it or moves it to another key. Tells the main window's UI that the status changed.
// shortcut: macOS lets two apps register the same key combination and gives the key to one of them, so a
// hotkey another app already has registers without an error; only a key the system refuses is reported.
// Check before registering (there is no public API for it) if that confuses someone.
pub async fn apply(app: &AppHandle) {
    let state = app.state::<CaptureState>();
    let _one = state.applying.lock().await;
    let (wanted, old) = {
        let registration = state.registration.lock().unwrap();
        (registration.wanted, registration.registered)
    };
    // The settings file decides, also against a UI that asks for the hotkey in a vault that is not on its list.
    let wanted = wanted && crate::settings::capture_on(app);
    let (want, mut error) = match wanted.then(|| parse(&crate::settings::capture_hotkey(app))) {
        None => (None, None),
        Some(Ok(shortcut)) => (Some(shortcut), None),
        Some(Err(message)) => (None, Some(message)),
    };
    let mut now = old;
    if old != want {
        let shortcuts = app.global_shortcut();
        if let Some(old) = old {
            let _ = shortcuts.unregister(old);
            now = None;
        }
        if let Some(new) = want {
            match shortcuts.register(new) {
                Ok(()) => now = Some(new),
                Err(e) => error = Some(format!("The hotkey {new} could not be registered: {e}")),
            }
        }
    }
    if let Some(error) = &error {
        eprintln!("inklode: quick capture has no hotkey: {error}");
    }
    {
        let mut registration = state.registration.lock().unwrap();
        registration.registered = now;
        registration.error = error;
    }
    let _ = app.emit_to("main", "app-settings-changed", ());
}

/// Says whether the UI has the `capture` module running, and registers or unregisters the hotkey to match.
pub async fn enable(app: &AppHandle, on: bool) {
    app.state::<CaptureState>().registration.lock().unwrap().wanted = on;
    apply(app).await;
}

/// The UI's side of `enable`: called when the module is switched on or off, also by opening another vault.
// `async`, so it runs off the main thread, which the shortcut plugin waits for.
#[tauri::command]
pub async fn capture_enable(window: tauri::WebviewWindow, app: AppHandle, on: bool) -> Result<(), String> {
    crate::main_only(&window)?;
    enable(&app, on).await;
    Ok(())
}

/// Shows the capture box and gives it the keyboard. The hotkey and the command `capture.open` both end here.
/// Not for the main thread: making the window waits for it.
// shortcut: the box comes up where it was last, in the middle of the display it was first shown on; move
// it to the display with the pointer if it is used with more than one display.
pub fn open(app: &AppHandle) -> Result<(), String> {
    let failed = |e: tauri::Error| e.to_string();
    let (window, new) = match app.get_webview_window(WINDOW) {
        Some(window) => (window, false),
        None => {
            let window = tauri::WebviewWindowBuilder::new(app, WINDOW, tauri::WebviewUrl::App("index.html#capture".into()))
                .title("Quick capture")
                .inner_size(560.0, 112.0)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .center()
                .build()
                .map_err(failed)?;
            (window, true)
        }
    };
    #[cfg(target_os = "macos")]
    {
        let shown = window.clone();
        window
            .run_on_main_thread(move || {
                if let Ok(ns_window) = shown.ns_window() {
                    // The pointer is this window's NSWindow, which lives as long as `shown`, and this is the main thread.
                    unsafe { panel::show(ns_window, new) };
                }
            })
            .map_err(failed)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = new;
        window.show().map_err(failed)?;
        window.set_focus().map_err(failed)
    }
}

/// `capture.open` in the UI.
#[tauri::command]
pub async fn capture_open(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    crate::main_only(&window)?;
    open(&app)
}

/// The box is done: with `text`, Enter was pressed and the main window's UI appends it to the capture note;
/// without, the user gave up. The box goes away, and the keyboard is back where it was before the box.
#[tauri::command]
pub fn capture_done(window: tauri::WebviewWindow, app: AppHandle, text: Option<String>) -> Result<(), String> {
    if window.label() != WINDOW {
        return Err("only the capture window may call this".into());
    }
    window.hide().map_err(|e| e.to_string())?;
    match text {
        Some(text) => app.emit_to("main", "capture-text", text).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// The capture box as a macOS panel.
#[cfg(target_os = "macos")]
mod panel {
    use std::ffi::c_void;

    use objc2::runtime::AnyObject;
    use objc2::{ClassType, MainThreadOnly, define_class};
    use objc2_app_kit::{NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};

    define_class!(
        // A panel with no title bar does not take the keyboard unless it says that it can.
        #[unsafe(super(NSPanel))]
        #[thread_kind = MainThreadOnly]
        #[name = "InklodeCapturePanel"]
        struct CapturePanel;

        impl CapturePanel {
            #[unsafe(method(canBecomeKeyWindow))]
            fn can_become_key_window(&self) -> bool {
                true
            }
        }
    );

    /// Shows the box over everything and gives it the keyboard, without making Inklode the active app.
    /// `new`: the window was just made, and is turned into a panel first.
    ///
    /// # Safety
    /// On the main thread, with the `NSWindow` of the capture window, which must be alive.
    // shortcut: with Inklode hidden (Cmd+H), bringing the box up unhides the app, so the main window shows
    // again behind the app in front; give the box to a helper process if that matters.
    // shortcut: Tauri has no panels, so the window it made gets the panel's class afterwards, which is what
    // the `tauri-nspanel` crate does too; use Tauri's own panel when it has one.
    pub unsafe fn show(ns_window: *mut c_void, new: bool) {
        let window = unsafe { &*ns_window.cast::<NSWindow>() };
        if new {
            // The window Tauri made is a few bytes larger than a panel (it has fields of its own, which stay
            // where they are and are still read by Tauri), so the panel's methods find everything they use.
            // objc2's own `set_class` refuses classes of different sizes, hence the plain runtime call.
            let object: *const NSWindow = window;
            unsafe { objc2::ffi::object_setClass(object.cast_mut().cast::<AnyObject>(), CapturePanel::class()) };
            // Takes key presses while another app stays the active one.
            window.setStyleMask(window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
            // On every Space, also the one of another app's fullscreen window.
            window.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary);
        }
        window.orderFrontRegardless();
        window.makeKeyWindow();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hotkey_is_modifiers_and_one_key() {
        assert!(parse(DEFAULT_HOTKEY).is_ok());
        assert_eq!(parse(" cmd+shift+K ").unwrap(), parse("Cmd+Shift+K").unwrap());
        for bad in ["", "Space", "A", "Ctrl+", "Ctrl+Alt", "Ctrl+A+B", "Ctrl+Nope"] {
            assert!(parse(bad).is_err(), "{bad:?} must be refused");
        }
    }
}
