//! App-level settings: `settings.json` in the app's config folder, as
//! `{"mcp": {"enabled": false, "port": 7811}, "capture": {"hotkey": "Ctrl+Alt+Space", "vaults": []}, "claims": {"trusted": []}}`.
//! Missing keys mean those defaults.
//!
//! The MCP server is switched on here and not in the vault's `.inklode/`, so that
//! a vault folder received from someone else cannot switch on a server. The global
//! hotkey of quick capture (capture.rs) is here for the same reason, with
//! `capture.vaults`: the folders of the vaults that have quick capture on. So is
//! `claims.trusted`: the folders of the vaults whose claims may run commands
//! (`core_call` in lib.rs). A vault cannot put itself on that list.
//!
//! `{"updates": {"auto": true}}` says whether the app looks for a newer version when it
//! starts. It is on unless the file says `false`.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::{capture, mcp};

/// The MCP server if it runs, and the reason it does not although it should.
#[derive(Default)]
pub struct McpState(tokio::sync::Mutex<(Option<mcp::Running>, Option<String>)>);

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// The settings file as a JSON object. A missing file is `{}`.
fn read(path: &Path) -> Result<Value, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    match serde_json::from_str(&text) {
        Ok(settings @ Value::Object(_)) => Ok(settings),
        Ok(_) => Err(format!("{} is not a JSON object", path.display())),
        Err(e) => Err(format!("{} is not valid JSON: {e}", path.display())),
    }
}

/// Writes the settings through a temporary file and a rename, like `Vault::write`.
fn write(path: &Path, settings: &Value) -> Result<(), String> {
    let failed = |e: std::io::Error| format!("{}: {e}", path.display());
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(failed)?;
    }
    let tmp = path.with_extension("json.inklode-tmp");
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&tmp, text + "\n").map_err(failed)?;
    fs::rename(&tmp, path).map_err(failed)
}

/// Held across the read and the write of one change to the settings file. The commands that change it are
/// async and can run at the same time: without this, two of them share the temporary file, so the second
/// rename fails with "No such file or directory", and the later write undoes the earlier one.
static CHANGING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Reads the settings file, applies `with` and writes the result, as one step. Returns what was written.
fn change(path: &Path, with: impl FnOnce(Value) -> Value) -> Result<Value, String> {
    let _one_at_a_time = CHANGING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let stored = with(read(path)?);
    write(path, &stored)?;
    Ok(stored)
}

/// `(enabled, port)` of the MCP server in the settings, with the default for a
/// key that is missing or unusable.
fn mcp_of(settings: &Value) -> (bool, u16) {
    let enabled = settings["mcp"]["enabled"].as_bool().unwrap_or(false);
    let port = settings["mcp"]["port"].as_u64().and_then(|port| u16::try_from(port).ok()).filter(|port| *port != 0);
    (enabled, port.unwrap_or(mcp::DEFAULT_PORT))
}

/// `settings` with the MCP values set. Every other key stays.
fn with_mcp(mut settings: Value, enabled: bool, port: u16) -> Value {
    if !settings["mcp"].is_object() {
        settings["mcp"] = json!({});
    }
    settings["mcp"]["enabled"] = json!(enabled);
    settings["mcp"]["port"] = json!(port);
    settings
}

/// The global hotkey of quick capture in the settings, with the default for a key that is missing or not text.
fn hotkey_of(settings: &Value) -> &str {
    settings["capture"]["hotkey"].as_str().filter(|hotkey| !hotkey.trim().is_empty()).unwrap_or(capture::DEFAULT_HOTKEY)
}

/// The global hotkey of quick capture as the settings file has it. A file that cannot be read counts as the default.
pub fn capture_hotkey(app: &AppHandle) -> String {
    let settings = file(app).and_then(|path| read(&path)).unwrap_or_default();
    hotkey_of(&settings).to_string()
}

/// Whether the vault at `root` is in `capture.vaults`: quick capture is on for it.
fn capture_on_of(settings: &Value, root: &Path) -> bool {
    let listed = settings["capture"]["vaults"].as_array();
    listed.is_some_and(|listed| listed.iter().any(|entry| entry.as_str().map(Path::new) == Some(root)))
}

/// `settings` with the vault at `root` put on `capture.vaults` or taken off it. Every other key stays.
fn with_capture(mut settings: Value, root: &str, on: bool) -> Value {
    if !settings["capture"].is_object() {
        settings["capture"] = json!({});
    }
    let mut listed = settings["capture"]["vaults"].as_array().cloned().unwrap_or_default();
    listed.retain(|entry| entry.as_str() != Some(root));
    if on {
        listed.push(json!(root));
    }
    settings["capture"]["vaults"] = Value::Array(listed);
    settings
}

/// Whether quick capture is on for the vault that is open, by the settings file. A file that
/// cannot be read has it on for no vault. Nothing in the vault is asked.
pub fn capture_on(app: &AppHandle) -> bool {
    let Some(root) = open_root(app) else { return false };
    file(app).and_then(|path| read(&path)).is_ok_and(|settings| capture_on_of(&settings, &root))
}

/// Whether the vault at `root` is in `claims.trusted`. `root` is the folder as the core has
/// it, which is how `claims_trust` writes it.
fn trusted_of(settings: &Value, root: &Path) -> bool {
    let listed = settings["claims"]["trusted"].as_array();
    listed.is_some_and(|listed| listed.iter().any(|entry| entry.as_str().map(Path::new) == Some(root)))
}

/// `settings` with the vault at `root` put on `claims.trusted` or taken off it. Every other key stays.
fn with_trust(mut settings: Value, root: &str, trusted: bool) -> Value {
    if !settings["claims"].is_object() {
        settings["claims"] = json!({});
    }
    let mut listed = settings["claims"]["trusted"].as_array().cloned().unwrap_or_default();
    listed.retain(|entry| entry.as_str() != Some(root));
    if trusted {
        listed.push(json!(root));
    }
    settings["claims"]["trusted"] = Value::Array(listed);
    settings
}

/// Whether the claims of the vault at `root` may run commands, by the settings file. A file
/// that cannot be read trusts no vault.
pub fn claims_trusted(app: &AppHandle, root: &Path) -> bool {
    file(app).and_then(|path| read(&path)).is_ok_and(|settings| trusted_of(&settings, root))
}

/// The folder of the vault that is open in the window.
fn open_root(app: &AppHandle) -> Option<PathBuf> {
    let core = app.state::<crate::SharedCore>();
    let core = core.lock().ok()?;
    core.root().map(Path::to_path_buf)
}

/// `INKLODE_MCP_PORT` when it is in force: set and not empty.
fn env_override() -> Option<String> {
    std::env::var("INKLODE_MCP_PORT").ok().filter(|value| !value.is_empty())
}

/// The answer of `app_settings_get` and `app_settings_set`.
fn report(app: &AppHandle, settings: &Value, running: &Option<mcp::Running>, error: &Option<String>) -> Value {
    let (enabled, port) = mcp_of(settings);
    json!({
        "mcp": { "enabled": enabled, "port": port },
        "mcpStatus": {
            "running": running.is_some(),
            "port": running.as_ref().map(|running| running.port),
            "error": error,
            "envOverride": env_override(),
        },
        // `on` is about the open vault only, like `claims.trusted`.
        "capture": { "hotkey": hotkey_of(settings), "on": open_root(app).is_some_and(|root| capture_on_of(settings, &root)) },
        "captureStatus": capture::status(app),
        // About the open vault only. The list itself is not for the window.
        "claims": { "trusted": open_root(app).is_some_and(|root| trusted_of(settings, &root)) },
        // `version` is the running app's, for the Updates block of the settings screen.
        "updates": { "auto": updates_auto_of(settings), "version": app.package_info().version.to_string() },
    })
}

/// Makes the MCP server match the settings file and `INKLODE_MCP_PORT`: starts, stops or
/// moves it to another port. Waits for the bind and returns the `app_settings_get` answer.
/// A settings file that cannot be read counts as the defaults and is reported as the error.
pub async fn apply(app: &AppHandle) -> Value {
    let state = app.state::<McpState>();
    let mut state = state.0.lock().await;
    let (running, error) = &mut *state;

    let (settings, unreadable) = match file(app).and_then(|path| read(&path)) {
        Ok(settings) => (settings, None),
        Err(message) => (Value::Null, Some(message)),
    };
    let (enabled, port) = mcp_of(&settings);
    let (wanted, bad_env) = match mcp::port(env_override().as_deref(), enabled.then_some(port)) {
        Ok(wanted) => (wanted, None),
        Err(message) => (None, Some(message)),
    };
    *error = unreadable.or(bad_env);

    if running.as_ref().map(|running| running.port) != wanted {
        if let Some(old) = running.take() {
            old.stop().await;
        }
        if let Some(port) = wanted {
            match mcp::start(app, port).await {
                Ok(started) => *running = Some(started),
                Err(message) => *error = Some(message),
            }
        }
    }
    report(app, &settings, running, error)
}

/// What the settings file says about the MCP server and the capture hotkey, and whether the one runs and the
/// other is registered:
/// `{mcp: {enabled, port}, mcpStatus: {running, port, error, envOverride}, capture: {hotkey, on}, captureStatus: {registered, error}, claims: {trusted}}`.
/// `claims.trusted` says whether the claims of the vault that is open now may run commands, `capture.on`
/// whether quick capture is on for it. The MCP token is not in it (mcp.rs).
#[tauri::command]
pub async fn app_settings_get(window: tauri::WebviewWindow, app: AppHandle) -> Result<Value, String> {
    crate::main_only(&window)?;
    let state = app.state::<McpState>();
    let state = state.0.lock().await;
    let settings = file(&app).and_then(|path| read(&path)).unwrap_or_default();
    Ok(report(&app, &settings, &state.0, &state.1))
}

/// Writes `{mcp: {enabled, port}}`, and `capture.hotkey` when it is given, to the settings file, applies
/// them and returns the same shape as `app_settings_get`. While `INKLODE_MCP_PORT` is in force the file is
/// written but the server does not change. A hotkey that is not a key combination is written as it is,
/// like a port that is taken: it is not registered, and `captureStatus.error` says why.
// shortcut: a settings file that is not valid JSON is never overwritten, so this fails until
// the user fixes or deletes the file; offer "reset settings" in the UI if that comes up.
#[tauri::command]
pub async fn app_settings_set(window: tauri::WebviewWindow, app: AppHandle, settings: Value) -> Result<Value, String> {
    crate::main_only(&window)?;
    let enabled = settings["mcp"]["enabled"].as_bool().ok_or("mcp.enabled must be true or false")?;
    let port = settings["mcp"]["port"].as_u64().and_then(|port| u16::try_from(port).ok()).filter(|port| *port != 0);
    let port = port.ok_or("mcp.port must be a number from 1 to 65535")?;
    let hotkey = match &settings["capture"]["hotkey"] {
        Value::Null => None,
        Value::String(hotkey) => Some(hotkey.trim()),
        _ => return Err("capture.hotkey must be text".into()),
    };
    let path = file(&app)?;
    change(&path, |settings| {
        let mut stored = with_mcp(settings, enabled, port);
        if let Some(hotkey) = hotkey {
            if !stored["capture"].is_object() {
                stored["capture"] = json!({});
            }
            stored["capture"]["hotkey"] = json!(hotkey);
        }
        stored
    })?;
    // Before the answer is made, so it says whether the new hotkey is registered.
    capture::apply(&app).await;
    Ok(apply(&app).await)
}

/// Switches quick capture on or off for the open vault: puts it on `capture.vaults` in the settings file or
/// takes it off, registers or unregisters the hotkey to match, and returns the same shape as
/// `app_settings_get`. This is the only thing that changes the list, and nothing in a vault is read for it.
#[tauri::command]
pub async fn capture_set(window: tauri::WebviewWindow, app: AppHandle, on: bool) -> Result<Value, String> {
    crate::main_only(&window)?;
    let root = open_root(&app).ok_or("no vault is open")?;
    let root = root.to_str().ok_or("the vault's path is not valid UTF-8")?;
    let path = file(&app)?;
    let stored = change(&path, |settings| with_capture(settings, root, on))?;
    capture::apply(&app).await;
    let state = app.state::<McpState>();
    let state = state.0.lock().await;
    Ok(report(&app, &stored, &state.0, &state.1))
}

/// Puts the open vault on `claims.trusted` in the settings file, or takes it off, and returns the same
/// shape as `app_settings_get`. This is the only thing that changes the list: `app_settings_set`
/// keeps it as it is, and nothing in a vault is read for it.
#[tauri::command]
pub async fn claims_trust(window: tauri::WebviewWindow, app: AppHandle, trusted: bool) -> Result<Value, String> {
    crate::main_only(&window)?;
    let root = open_root(&app).ok_or("no vault is open")?;
    let root = root.to_str().ok_or("the vault's path is not valid UTF-8")?;
    if trusted {
        // Asked in a native dialog, which page code cannot answer: the window alone must not be
        // able to switch on running commands.
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        let dialog = app
            .dialog()
            .message(format!("Commands written in the notes of this vault will run on this Mac when you press Check.\n\n{root}"))
            .title("Allow this vault to run commands?")
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into()));
        let allowed = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await.map_err(|e| e.to_string())?;
        if !allowed {
            return Err("not allowed: the question was cancelled".into());
        }
    }
    let path = file(&app)?;
    let stored = change(&path, |settings| with_trust(settings, root, trusted))?;
    let state = app.state::<McpState>();
    let state = state.0.lock().await;
    Ok(report(&app, &stored, &state.0, &state.1))
}

/// Whether the app looks for a newer version when it starts: `updates.auto`, true unless the file says false.
fn updates_auto_of(settings: &Value) -> bool {
    settings["updates"]["auto"].as_bool().unwrap_or(true)
}

/// `settings` with `updates.auto` set. Every other key stays.
fn with_updates_auto(mut settings: Value, auto: bool) -> Value {
    if !settings["updates"].is_object() {
        settings["updates"] = json!({});
    }
    settings["updates"]["auto"] = json!(auto);
    settings
}

/// Writes `updates.auto` to the settings file and returns the same shape as `app_settings_get`.
/// The check itself is made by the window (src/updates.ts), which reads this when it starts.
#[tauri::command]
pub async fn updates_set(window: tauri::WebviewWindow, app: AppHandle, auto: bool) -> Result<Value, String> {
    crate::main_only(&window)?;
    let path = file(&app)?;
    let stored = change(&path, |settings| with_updates_auto(settings, auto))?;
    let state = app.state::<McpState>();
    let state = state.0.lock().await;
    Ok(report(&app, &stored, &state.0, &state.1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_at_the_same_time_all_land() {
        let dir = std::env::temp_dir().join(format!("inklode-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        let saves: Vec<_> = (0..16)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || {
                    change(&path, |mut settings| {
                        settings[format!("key{n}")] = json!(n);
                        settings
                    })
                })
            })
            .collect();
        for save in saves {
            save.join().unwrap().unwrap();
        }
        let stored = read(&path).unwrap();
        for n in 0..16 {
            assert_eq!(stored[format!("key{n}")], json!(n));
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checking_for_updates_at_start_is_on_unless_switched_off() {
        assert!(updates_auto_of(&json!({})));
        assert!(updates_auto_of(&json!({ "updates": { "auto": "no" } })));
        assert!(!updates_auto_of(&json!({ "updates": { "auto": false } })));

        let stored = with_updates_auto(json!({ "mcp": { "port": 9000 }, "updates": { "other": 1 } }), false);
        assert_eq!(stored, json!({ "mcp": { "port": 9000 }, "updates": { "other": 1, "auto": false } }));
        assert_eq!(with_updates_auto(json!({ "updates": 3 }), true), json!({ "updates": { "auto": true } }));
    }

    #[test]
    fn quick_capture_is_on_only_for_a_vault_whose_folder_is_on_the_list() {
        let (a, b) = (Path::new("/vaults/a"), Path::new("/vaults/b"));
        assert!(!capture_on_of(&json!({}), a));
        assert!(!capture_on_of(&json!({ "capture": { "vaults": true } }), a));
        assert!(!capture_on_of(&json!({ "capture": { "hotkey": "Ctrl+Alt+Space", "vaults": ["/vaults", "/vaults/a/b", 3] } }), a));

        let stored = with_capture(json!({ "capture": { "hotkey": "Cmd+Shift+K" }, "claims": { "trusted": ["/vaults/b"] } }), "/vaults/a", true);
        assert_eq!(stored, json!({ "capture": { "hotkey": "Cmd+Shift+K", "vaults": ["/vaults/a"] }, "claims": { "trusted": ["/vaults/b"] } }));
        assert!(capture_on_of(&stored, a) && !capture_on_of(&stored, b));
        assert_eq!(hotkey_of(&stored), "Cmd+Shift+K");
        let off = with_capture(with_capture(stored, "/vaults/a", true), "/vaults/a", false);
        assert_eq!(off["capture"]["vaults"], json!([]));
        assert!(!capture_on_of(&off, a));
    }

    #[test]
    fn a_vault_is_trusted_only_when_its_folder_is_on_the_list() {
        let (a, b) = (Path::new("/vaults/a"), Path::new("/vaults/b"));
        assert!(!trusted_of(&json!({}), a));
        assert!(!trusted_of(&json!({ "claims": { "trusted": true } }), a));
        assert!(!trusted_of(&json!({ "claims": { "trusted": ["/vaults", "/vaults/a/b", "/vaults/A", 3] } }), a));

        let stored = with_trust(json!({ "mcp": { "port": 9000 }, "claims": { "other": 1 } }), "/vaults/a", true);
        assert_eq!(stored, json!({ "mcp": { "port": 9000 }, "claims": { "other": 1, "trusted": ["/vaults/a"] } }));
        assert!(trusted_of(&stored, a) && !trusted_of(&stored, b));
        // Trusted twice is listed once, and the other vault stays when one is taken off.
        let both = with_trust(with_trust(stored, "/vaults/b", true), "/vaults/a", true);
        assert_eq!(both["claims"]["trusted"], json!(["/vaults/b", "/vaults/a"]));
        let one = with_trust(both, "/vaults/a", false);
        assert_eq!(one["claims"]["trusted"], json!(["/vaults/b"]));
        assert!(!trusted_of(&one, a) && trusted_of(&one, b));
        assert_eq!(with_trust(json!({ "claims": 3 }), "/vaults/a", false), json!({ "claims": { "trusted": [] } }));
        // The MCP settings are written without touching the list.
        assert!(trusted_of(&with_mcp(one, true, 1), b));
    }

    #[test]
    fn mcp_settings_default_and_keep_other_keys() {
        assert_eq!(mcp_of(&json!({})), (false, mcp::DEFAULT_PORT));
        assert_eq!(mcp_of(&json!({ "mcp": { "enabled": true, "port": 70000 } })), (true, mcp::DEFAULT_PORT));
        assert_eq!(mcp_of(&json!({ "mcp": { "port": 9000 } })), (false, 9000));

        let stored = json!({ "other": 1, "mcp": { "enabled": false, "note": "x" } });
        assert_eq!(
            with_mcp(stored, true, 9000),
            json!({ "other": 1, "mcp": { "enabled": true, "port": 9000, "note": "x" } })
        );
        assert_eq!(with_mcp(json!({ "mcp": 3 }), false, 1), json!({ "mcp": { "enabled": false, "port": 1 } }));

        assert_eq!(hotkey_of(&json!({})), capture::DEFAULT_HOTKEY);
        assert_eq!(hotkey_of(&json!({ "capture": { "hotkey": 3 } })), capture::DEFAULT_HOTKEY);
        assert_eq!(hotkey_of(&json!({ "capture": { "hotkey": "Cmd+Shift+K" } })), "Cmd+Shift+K");
    }
}
