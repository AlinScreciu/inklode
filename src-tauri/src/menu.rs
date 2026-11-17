//! The macOS menu bar. Without one, the system's default menu has "Close Window ⌘W", which closes the
//! window where the app means "close tab".
//!
//! An item with a command id runs that command of the UI (src/commands.ts): the id goes to the main
//! window as a `menu-command` event. The Edit items are the system's own, which the webview answers.
// shortcut: the keys shown here are the commands' default keys and do not follow the vault's keys.json;
// rebuild the menu from the UI's command list when keys are rebound for real.

use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

/// Not a UI command: closes the window in front.
const CLOSE_WINDOW: &str = "window.close";
/// A UI command, run whichever window is in front.
const QUIT: &str = "app.quit";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str, key: Option<&str>| MenuItem::with_id(app, id, text, true, key);
    let inklode = SubmenuBuilder::new(app, "Inklode")
        .about(None)
        .item(&item("app.checkForUpdates", "Check for Updates…", None)?)
        .separator()
        .item(&item("settings.open", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        // Not the system's own Quit item, which ends the app at once: this one runs the UI's `app.quit`,
        // which writes what was typed and not saved yet, and then ends the app.
        // shortcut: if the window's UI hangs, this Quit does nothing and the app has to be force quit.
        .item(&item(QUIT, "Quit Inklode", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("note.new", "New Note…", Some("CmdOrCtrl+N"))?)
        .item(&item("tab.new", "New Tab", Some("CmdOrCtrl+T"))?)
        .item(&item("note.switch", "Open Note…", Some("CmdOrCtrl+O"))?)
        .item(&item("vault.open", "Open Vault…", None)?)
        .separator()
        .item(&item("note.save", "Save", Some("CmdOrCtrl+S"))?)
        .separator()
        .item(&item("tab.close", "Close Tab", Some("CmdOrCtrl+W"))?)
        .item(&item(CLOSE_WINDOW, "Close Window", Some("CmdOrCtrl+Shift+W"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("search.open", "Search in All Notes", Some("CmdOrCtrl+Shift+F"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("palette.open", "Command Palette", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item("sidebar.toggle", "Toggle Sidebar", Some("CmdOrCtrl+\\"))?)
        .item(&item("outline.toggle", "Toggle Outline", Some("CmdOrCtrl+Shift+O"))?)
        .item(&item("editor.toggleSource", "Toggle Source Mode", Some("CmdOrCtrl+E"))?)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
    app.set_menu(MenuBuilder::new(app).items(&[&inklode, &file, &edit, &view, &window]).build()?)?;
    app.on_menu_event(|app, event| run(app, event.id().as_ref()));
    Ok(())
}

/// What a menu item with this id does, by the window in front.
fn run(app: &AppHandle, id: &str) {
    let front = app.webview_windows().into_values().find(|window| window.is_focused().unwrap_or(false));
    match front {
        _ if id == QUIT => {
            let _ = app.emit_to("main", "menu-command", id);
        }
        // The presenter window has no commands and must not act on the vault through the main window:
        // there, both "close" items close it and the rest does nothing.
        Some(window) if window.label() != "main" => {
            if id == CLOSE_WINDOW || id == "tab.close" {
                let _ = window.close();
            }
        }
        Some(window) if id == CLOSE_WINDOW => {
            let _ = window.close();
        }
        _ if id == CLOSE_WINDOW => {}
        _ => {
            let _ = app.emit_to("main", "menu-command", id);
        }
    }
}
