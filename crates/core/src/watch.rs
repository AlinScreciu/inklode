//! Watches the vault folder and reports changes made on disk.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_mini::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{Config, DebounceEventResult, Debouncer, new_debouncer_opt};
use serde_json::{Value, json};

pub type Listener = Arc<Mutex<Option<Box<dyn Fn(Value) + Send + Sync>>>>;
pub type Watcher = Debouncer<RecommendedWatcher>;

/// Watches `root` recursively. Changes are collected for 250 ms. Then the
/// listener gets one `vault.changed` event with the changed paths and `dirty`
/// is set, and one `config.changed` event with the changed paths under
/// `.inklode/`, which does not set `dirty` because config files are not notes.
/// Symbolic links are not followed out of the vault: none is walked into, and a path that
/// a link takes out of the vault is not reported.
/// Watching stops when the returned value is dropped.
pub fn watch(root: &Path, dirty: Arc<AtomicBool>, listener: Listener) -> notify::Result<Watcher> {
    let base = root.to_path_buf();
    // A linked folder in the vault is watched at its real place, like every other folder.
    let config = Config::default().with_timeout(Duration::from_millis(250)).with_notify_config(notify::Config::default().with_follow_symlinks(false));
    let mut debouncer = new_debouncer_opt(config, move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let mut paths: Vec<String> = events.iter().filter_map(|e| relative(&base, &e.path)).filter(|path| crate::vault::real(&base, path).is_ok()).collect();
        paths.sort();
        paths.dedup();
        let (config, paths): (Vec<String>, Vec<String>) = paths.into_iter().partition(|p| p.starts_with(".inklode/"));
        if !paths.is_empty() {
            dirty.store(true, Ordering::SeqCst);
        }
        let listener = listener.lock().unwrap();
        let Some(listener) = listener.as_ref() else { return };
        for (kind, paths) in [("vault.changed", paths), ("config.changed", config)] {
            if !paths.is_empty() {
                listener(json!({ "type": kind, "paths": paths }));
            }
        }
    })?;
    debouncer.watcher().watch(root, RecursiveMode::Recursive)?;
    Ok(debouncer)
}

/// The vault-relative path with forward slashes, or `None` for paths that are
/// not reported: the temporary files of `Vault::write`, and anything under a
/// dot name. The one dot name that is reported is the top-level `.inklode`
/// folder, for the files in it (not the folder itself).
fn relative(root: &Path, path: &Path) -> Option<String> {
    let parts: Vec<_> = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    let in_config = parts.len() > 1 && parts[0] == ".inklode";
    let hidden = parts.iter().skip(in_config as usize).any(|p| p.starts_with('.')) || parts.last()?.ends_with(".inklode-tmp");
    (!hidden).then(|| parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_skips_dot_names_and_temp_files_but_keeps_inklode_config() {
        let root = Path::new("/v");
        assert_eq!(relative(root, Path::new("/v/a/b.md")).as_deref(), Some("a/b.md"));
        assert_eq!(relative(root, Path::new("/v/.inklode/themes/x.css")).as_deref(), Some(".inklode/themes/x.css"));
        let skipped = [
            "/v",
            "/v/.git/HEAD",
            "/v/a/.b.md.inklode-tmp",
            "/v/x.inklode-tmp",
            "/elsewhere/a.md",
            "/v/.inklode",
            "/v/.inklode/.settings.json.inklode-tmp",
            "/v/.inklode/.DS_Store",
            "/v/a/.inklode/settings.json",
        ];
        for skipped in skipped {
            assert_eq!(relative(root, Path::new(skipped)), None, "{skipped}");
        }
    }
}
