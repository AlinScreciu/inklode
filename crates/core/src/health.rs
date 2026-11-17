//! `vault.health`: what in a vault needs looking after. Broken links and notes without
//! links come from the index; this file adds the notes that are stale against the code
//! they describe, by this rule:
//!
//! A note with `repos: [name, ...]` and `updated: YYYY-MM-DD` in its frontmatter is stale
//! when any branch of one of those repositories has a commit dated after the `updated:`
//! day. Commits made on the day itself do not count. A `repos:` entry is a path
//! (`~/projects/foo`) or a folder name, and a folder name is looked up, up to three levels
//! deep, under the folders in `$VAULT_REPO_ROOTS` (colon-separated; default
//! `~/projects:~/work:~/misc`).
//!
//! Git is only read (`rev-parse` and `log`), and nothing is fetched: a commit that was
//! not fetched yet is not seen.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::git;
use crate::index::{Broken, Index};

/// The result of `vault.health`.
#[derive(Debug, Serialize)]
pub struct Health {
    pub broken: Vec<Broken>,
    /// The notes no other note links to and that link to no other note, by path.
    pub orphans: Vec<String>,
    /// One per note and repository with newer commits, by path.
    pub stale: Vec<Stale>,
    /// What could not be checked for staleness, by path.
    pub unchecked: Vec<Unchecked>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Stale {
    pub path: String,
    /// The note's `updated:` day.
    pub updated: String,
    /// The `repos:` entry as written, and the folder it was found at.
    pub repo: String,
    pub dir: String,
    /// How many commits are dated after `updated`, on all branches.
    pub commits: usize,
    pub newest: Newest,
}

/// The newest of those commits.
#[derive(Debug, Serialize, PartialEq)]
pub struct Newest {
    /// The committer's day, `YYYY-MM-DD`.
    pub date: String,
    /// The short hash.
    pub rev: String,
    pub subject: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Unchecked {
    pub path: String,
    /// The `repos:` entry that was not found, or null when the note's `updated:` is the problem.
    pub repo: Option<String>,
    pub reason: String,
}

/// The folders repositories are looked up in: `$VAULT_REPO_ROOTS`, or the default.
pub fn roots() -> Vec<PathBuf> {
    let roots = std::env::var("VAULT_REPO_ROOTS").unwrap_or_else(|_| "~/projects:~/work:~/misc".to_string());
    roots.split(':').filter(|root| !root.is_empty()).map(expand).collect()
}

// shortcut: the stale check runs `git log` once per note and repository on every call,
// and a folder name walks the roots each time; remember the answer per repository and
// its refs if a vault with many `repos:` notes makes the panel slow.
pub fn report(index: &Index, roots: &[PathBuf]) -> Health {
    let orphans = index.graph().nodes.into_iter().filter(|node| node.links == 0).map(|node| node.path).collect();
    let (mut stale, mut unchecked) = (Vec::new(), Vec::new());
    for (path, text) in index.texts() {
        let (repos, updated) = meta(text);
        if repos.is_empty() {
            continue;
        }
        let Some(since) = updated.as_deref().and_then(day_after) else {
            unchecked.push(Unchecked { path: path.to_string(), repo: None, reason: "no valid `updated:` date".to_string() });
            continue;
        };
        for repo in repos {
            let dir = find_repo(&repo, roots).filter(|dir| git(dir, &["rev-parse", "--git-dir"]).is_some());
            let Some(dir) = dir else {
                unchecked.push(Unchecked { path: path.to_string(), repo: Some(repo), reason: "not found or not a git repository".to_string() });
                continue;
            };
            // Newest first. `%cs` is the committer's day, which is the date `--since` goes by.
            let log = git(&dir, &["log", "--all", &format!("--since={since}T00:00:00"), "--format=%cs%x1f%h%x1f%s"]).unwrap_or_default();
            let log = String::from_utf8_lossy(&log);
            let mut fields = log.lines().next().unwrap_or_default().split('\x1f').map(str::to_string);
            if let (Some(date), Some(rev), Some(subject)) = (fields.next(), fields.next(), fields.next()) {
                stale.push(Stale {
                    path: path.to_string(),
                    updated: updated.clone().unwrap_or_default(),
                    repo,
                    dir: dir.to_string_lossy().into_owned(),
                    commits: log.lines().count(),
                    newest: Newest { date, rev, subject },
                });
            }
        }
    }
    Health { broken: index.broken(), orphans, stale, unchecked }
}

/// `~` and `~/…` as the home folder.
pub(crate) fn expand(path: &str) -> PathBuf {
    match (path.strip_prefix('~'), std::env::home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    }
}

/// The folder a `repos:` entry names: the path itself, or the first folder of that name
/// under `roots`, at most three levels down (`root/name`, `root/a/name`, `root/a/b/name`).
/// Folders that start with a dot and `node_modules` are not looked into.
// The script's own walk stops one level sooner than its description says (`root/a/name`);
// this follows the description.
fn find_repo(entry: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let path = expand(entry);
    if path.is_absolute() {
        return path.is_dir().then_some(path);
    }
    fn walk(dir: &Path, entry: &str, deeper: usize) -> Option<PathBuf> {
        let found = dir.join(entry);
        if found.is_dir() {
            return Some(found);
        }
        if deeper == 0 {
            return None;
        }
        let mut inside: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        inside.sort();
        let skipped = |p: &PathBuf| p.file_name().and_then(|name| name.to_str()).is_none_or(|name| name.starts_with('.') || name == "node_modules");
        inside.iter().filter(|p| !skipped(p)).find_map(|p| walk(p, entry, deeper - 1))
    }
    roots.iter().find_map(|root| walk(root, entry, 2))
}

/// `repos` and `updated` of a note's frontmatter, read line by line, not as full YAML:
/// `key: value`, `key: [a, b]` and `- item` lines under a key, with quotes and a trailing
/// `# comment` taken off. `updated` is `None` when it is missing or a list.
fn meta(text: &str) -> (Vec<String>, Option<String>) {
    let mut lines = text.lines();
    let (mut repos, mut updated) = (Vec::new(), None);
    if lines.next().map(str::trim_end) != Some("---") {
        return (repos, updated);
    }
    let clean = |value: &str| {
        let value = value.trim();
        let quoted = value.len() >= 2 && (value.starts_with('"') && value.ends_with('"') || value.starts_with('\'') && value.ends_with('\''));
        let value = if quoted { &value[1..value.len() - 1] } else { value.find(" #").map_or(value, |at| value[..at].trim_end()) };
        value.to_string()
    };
    let mut key = "";
    let mut closed = false;
    for line in lines {
        if line.trim_end() == "---" {
            closed = true;
            break;
        }
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let named = line.split_once(':').filter(|(name, _)| !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        if let Some((name, value)) = named {
            key = name;
            let value = value.trim();
            let list = value.strip_prefix('[').and_then(|rest| rest.rsplit_once(']')).map(|(inner, _)| inner);
            match (key, list) {
                // An entry with a comma in it is not read as one, quoted or not.
                ("repos", Some(inner)) => repos = inner.split(',').map(clean).collect(),
                ("repos", None) => repos = vec![clean(value)],
                ("updated", None) => updated = Some(clean(value)),
                ("updated", Some(_)) => updated = None,
                _ => {}
            }
        } else if let Some(item) = line.trim_start().strip_prefix('-').filter(|item| item.starts_with([' ', '\t'])) {
            match key {
                "repos" => repos.push(clean(item)),
                "updated" => updated = None,
                _ => {}
            }
        }
    }
    repos.retain(|repo| !repo.is_empty());
    // Without the closing `---` the note has no frontmatter.
    if closed { (repos, updated.filter(|day| !day.is_empty())) } else { (Vec::new(), None) }
}

/// The day after `day` (`YYYY-MM-DD`), in the same form. `None` when `day` is not a date.
fn day_after(day: &str) -> Option<String> {
    let bytes = day.as_bytes();
    let digits = |range: std::ops::Range<usize>| day.get(range)?.parse::<u32>().ok();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' || !day.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return None;
    }
    let (year, month, date) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => return None,
    };
    if year == 0 || date == 0 || date > days {
        return None;
    }
    let (year, month, date) = match (month, date) {
        (12, 31) => (year + 1, 1, 1),
        (_, date) if date == days => (year, month + 1, 1),
        _ => (year, month, date + 1),
    };
    Some(format!("{year:04}-{month:02}-{date:02}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_day_after_a_date_and_none_for_what_is_not_one() {
        assert_eq!(day_after("2026-03-01").as_deref(), Some("2026-03-02"));
        assert_eq!(day_after("2026-04-30").as_deref(), Some("2026-05-01"));
        assert_eq!(day_after("2026-12-31").as_deref(), Some("2027-01-01"));
        assert_eq!(day_after("2024-02-28").as_deref(), Some("2024-02-29"));
        assert_eq!(day_after("2026-02-28").as_deref(), Some("2026-03-01"));
        for bad in ["", "2026-02-29", "2026-13-01", "2026-00-10", "2026-3-1", "20260301", "yesterday", "2026-03-01T10:00"] {
            assert_eq!(day_after(bad), None, "{bad}");
        }
    }

    #[test]
    fn repos_and_updated_are_read_from_frontmatter_in_its_three_forms() {
        let read = |text: &str| meta(text);
        assert_eq!(read("---\nrepos: [inklode, \"~/work/api\"]\nupdated: 2026-03-01\n---\ntext\n"), (vec!["inklode".to_string(), "~/work/api".to_string()], Some("2026-03-01".to_string())));
        assert_eq!(read("---\nupdated: '2026-03-01'  \nrepos:\n  - inklode # the app\n  - api\ntags: [x]\n---\n"), (vec!["inklode".to_string(), "api".to_string()], Some("2026-03-01".to_string())));
        assert_eq!(read("---\nrepos: inklode\n---\n"), (vec!["inklode".to_string()], None));
        // No frontmatter: not at the top, or never closed.
        assert_eq!(read("text\n---\nrepos: [a]\n---\n"), (vec![], None));
        assert_eq!(read("---\nrepos: [a]\nupdated: 2026-03-01\n"), (vec![], None));
        assert_eq!(read("---\nrepos: []\nupdated: 2026-03-01\n---\n").0, Vec::<String>::new());
    }

    #[test]
    fn a_folder_name_is_found_up_to_three_levels_under_a_root() {
        let dir = tempfile::tempdir().unwrap();
        for path in ["one/top", "one/a/mid", "one/a/b/deep", "one/a/b/c/lost", "one/.hidden/dotted", "one/node_modules/pkg", "two/other"] {
            std::fs::create_dir_all(dir.path().join(path)).unwrap();
        }
        let roots = [dir.path().join("missing"), dir.path().join("one"), dir.path().join("two")];
        let found = |entry: &str| find_repo(entry, &roots).map(|p| p.strip_prefix(dir.path()).unwrap().to_string_lossy().into_owned());
        assert_eq!(found("top").as_deref(), Some("one/top"));
        assert_eq!(found("mid").as_deref(), Some("one/a/mid"));
        assert_eq!(found("deep").as_deref(), Some("one/a/b/deep"));
        assert_eq!(found("other").as_deref(), Some("two/other"));
        for entry in ["lost", "dotted", "pkg", "nope"] {
            assert_eq!(found(entry), None, "{entry}");
        }
        // A path is taken as it is, and is not looked up.
        let absolute = dir.path().join("one/a/b/c/lost");
        assert_eq!(find_repo(absolute.to_str().unwrap(), &roots), Some(absolute));
        assert_eq!(find_repo(dir.path().join("nope").to_str().unwrap(), &roots), None);
    }
}
