//! `vault.health`: what in a vault needs looking after. Broken links and notes without
//! links come from the index; this file adds the notes that are stale against the code
//! they describe, by this rule:
//!
//! A note with `repos: [name, ...]` and `updated: YYYY-MM-DD` in its frontmatter is stale
//! when the default branch of one of those repositories has a commit dated after the
//! `updated:` day. Commits made on the day itself do not count.
//!
//! - A `repos:` entry is a path (`~/projects/foo`) or a folder name, and a folder name is
//!   looked up, up to three levels deep, under the folders in `$VAULT_REPO_ROOTS`
//!   (colon-separated; default `~/projects:~/work:~/misc`). The folder must be the root of
//!   a repository: a folder inside one is not taken for it.
//! - The default branch is `origin/HEAD` as last fetched, and what is checked out in a
//!   repository that has no `origin/HEAD`. Other branches do not count.
//! - An entry can end in a scope: `name:dir` counts only the commits that change something
//!   under `dir` (a path from the repository's root), `name:!dir` only those that change
//!   something outside it.
//! - A commit that changes nothing but the files in `HOUSEKEEPING` does not count.
//!
//! Git is only read (`rev-parse`, `show-ref` and `log`), and nothing is fetched: a commit that was
//! not fetched yet is not seen.
//!
//! The commits read from a repository are kept (`Logs`) for as long as its default branch
//! stays at the same commit, so a report on repositories that did not change runs no `git log`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;

use crate::git::git;
use crate::index::{is_template, Broken, Index};

/// Files at a repository's root that say how the repository is kept, not what the code
/// does: a commit that changes only these makes no note stale.
const HOUSEKEEPING: &[&str] = &[".gitignore", ".gitattributes", ".editorconfig", ".github/CODEOWNERS", ".pre-commit-config.yaml"];

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
    /// The `repos:` entry as written, with its scope, and the repository's folder.
    pub repo: String,
    pub dir: String,
    /// How many commits of the default branch that count are dated after `updated`.
    pub commits: usize,
    pub newest: Newest,
}

/// The newest of those commits.
#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct Newest {
    /// The day it was committed, `YYYY-MM-DD` in local time.
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

/// The commits read so far, by repository and scope, shared by the reports of one core.
pub(crate) type Cache = Arc<Mutex<Logs>>;

#[derive(Default)]
pub(crate) struct Logs {
    kept: HashMap<(PathBuf, Scope), Kept>,
    /// How many times `git log` ran, for the tests.
    #[cfg(test)]
    read: usize,
}

/// What `git log` gave for one repository and scope.
struct Kept {
    /// The commit the default branch was at. Another commit there makes this old.
    rev: String,
    /// The day the commits were read from. A report that asks from an earlier day reads again.
    since: String,
    log: Vec<Newest>,
}

/// What one `vault.health` needs of the index, taken out of it by [`check`], so that a host
/// can run the git part without holding the core: it takes seconds in a vault whose notes
/// name many repositories, and the window reads and saves notes meanwhile.
pub struct HealthCheck {
    broken: Vec<Broken>,
    orphans: Vec<String>,
    /// The notes with `repos:`, as `(path, repos, updated)`.
    notes: Vec<(String, Vec<String>, Option<String>)>,
    roots: Vec<PathBuf>,
    cache: Cache,
}

/// The part of the report that comes from the index, and what the stale check will read.
/// `cache` has the commits earlier reports read.
pub(crate) fn check(index: &Index, roots: Vec<PathBuf>, cache: Cache) -> HealthCheck {
    // Templates are left out of all three lists.
    let kept = |path: &str| !is_template(path);
    let broken = index.broken().into_iter().filter(|note| kept(&note.path)).collect();
    let orphans = index.graph().nodes.into_iter().filter(|node| node.links == 0 && kept(&node.path)).map(|node| node.path).collect();
    let notes = index.texts().filter(|(path, _)| kept(path)).map(|(path, text)| (path, meta(text))).filter(|(_, (repos, _))| !repos.is_empty());
    let notes = notes.map(|(path, (repos, updated))| (path.to_string(), repos, updated)).collect();
    HealthCheck { broken, orphans, notes, roots, cache }
}

/// Which commits of a repository an entry counts.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Scope {
    All,
    /// Those that change something under this folder.
    Only(String),
    /// Those that change something outside this folder.
    Except(String),
}

impl HealthCheck {
    /// The report. Runs git in the repositories the notes name, and reads nothing of the vault.
    // shortcut: every report still asks git twice per repository, for its root and for the commit
    // its default branch is at, and walks the lookup folders; watch the repositories' refs if
    // that gets slow in a vault that names hundreds of them.
    pub fn run(self) -> Health {
        // Many notes name the same repository, so each one is found once and its commits are
        // read once per scope, from the earliest day a note asks about.
        let since = |updated: &Option<String>| updated.as_deref().and_then(day_after);
        let mut earliest: HashMap<(&str, Scope), String> = HashMap::new();
        for (_, entries, updated) in &self.notes {
            let Some(since) = since(updated) else { continue };
            for entry in entries {
                let day = earliest.entry(scoped(entry)).or_insert_with(|| since.clone());
                if since < *day {
                    *day = since.clone();
                }
            }
        }
        // A vault whose notes name no repository walks no folder.
        let folders = if earliest.is_empty() { Vec::new() } else { lookup_folders(&self.roots) };
        let mut repos: HashMap<&str, Option<PathBuf>> = HashMap::new();
        let mut logs: HashMap<(&str, Scope), Vec<Newest>> = HashMap::new();
        let (mut stale, mut unchecked) = (Vec::new(), Vec::new());
        for (path, entries, updated) in &self.notes {
            let Some(since) = since(updated) else {
                unchecked.push(Unchecked { path: path.clone(), repo: None, reason: "no valid `updated:` date".to_string() });
                continue;
            };
            for entry in entries {
                let (name, scope) = scoped(entry);
                let Some(dir) = repos.entry(name).or_insert_with(|| repository(name, &folders)) else {
                    unchecked.push(Unchecked { path: path.clone(), repo: Some(entry.clone()), reason: "not found or not a git repository".to_string() });
                    continue;
                };
                let key = (name, scope);
                let log = logs.entry(key.clone()).or_insert_with(|| commits(dir, &earliest[&key], &key.1, &self.cache));
                // Days in the form `YYYY-MM-DD` are in order as text.
                let mut newer = log.iter().filter(|commit| commit.date >= since);
                if let Some(newest) = newer.next() {
                    stale.push(Stale { path: path.clone(), updated: updated.clone().unwrap_or_default(), repo: entry.clone(), dir: dir.to_string_lossy().into_owned(), commits: 1 + newer.count(), newest: newest.clone() });
                }
            }
        }
        Health { broken: self.broken, orphans: self.orphans, stale, unchecked }
    }
}

/// A `repos:` entry as the repository it names and its scope: `name`, `name:dir` or `name:!dir`.
fn scoped(entry: &str) -> (&str, Scope) {
    // What follows the colon of a Windows drive (`C:\code\app`) is the path, not a scope.
    let Some((name, dir)) = entry.rsplit_once(':').filter(|(_, dir)| !dir.starts_with(['\\', '/'])) else {
        return (entry, Scope::All);
    };
    let clean = |dir: &str| dir.trim().trim_end_matches('/').to_string();
    let scope = match dir.trim().strip_prefix('!') {
        Some(dir) if !clean(dir).is_empty() => Scope::Except(clean(dir)),
        None if !clean(dir).is_empty() => Scope::Only(clean(dir)),
        _ => Scope::All,
    };
    (name.trim(), scope)
}

/// The root of the repository that `name` leads to. `None` when there is no such folder,
/// or it is not the root of a repository: a folder inside a repository (a chart in a
/// repository of charts) has that repository's whole history, which says nothing about the
/// code the note names.
fn repository(name: &str, folders: &[PathBuf]) -> Option<PathBuf> {
    let dir = find_repo(name, folders)?;
    let top = git(&dir, &["rev-parse", "--show-toplevel"])?;
    let top = PathBuf::from(String::from_utf8_lossy(&top).trim_end_matches(['\n', '\r']));
    // Compared as the real folders: git prints its path with the links in it followed.
    (std::fs::canonicalize(&dir).ok()? == std::fs::canonicalize(top).ok()?).then_some(dir)
}

/// The commit the default branch is at. `origin/HEAD` is the remote's default branch as last
/// fetched; a repository without it (never cloned, or the remote added by hand) is read from
/// what is checked out. `None` in a repository without a commit.
fn default_commit(dir: &Path) -> Option<String> {
    // One run for both: with `--head` the list has `HEAD` itself and every ref that ends in `/HEAD`.
    let out = git(dir, &["show-ref", "--head", "HEAD"])?;
    let text = String::from_utf8_lossy(&out);
    let at = |name: &str| text.lines().filter_map(|line| line.split_once(' ')).find(|(_, of)| *of == name).map(|(hash, _)| hash.to_string());
    at("refs/remotes/origin/HEAD").or_else(|| at("HEAD"))
}

/// The commits of the default branch that are dated from the day `since` on and count in
/// `scope`, newest first, or more of them: from an earlier day, when an earlier report read
/// those. None in a repository without a commit. Git reads the history only when `cache`
/// has nothing for the commit the branch is at now.
fn commits(dir: &Path, since: &str, scope: &Scope, cache: &Cache) -> Vec<Newest> {
    let Some(rev) = default_commit(dir) else { return Vec::new() };
    let key = (dir.to_path_buf(), scope.clone());
    // Days in the form `YYYY-MM-DD` are in order as text.
    let fresh = |kept: &&Kept| kept.rev == rev && kept.since.as_str() <= since;
    if let Some(kept) = cache.lock().unwrap_or_else(PoisonError::into_inner).kept.get(&key).filter(fresh) {
        return kept.log.clone();
    }
    // Paths are from the repository's root and taken letter by letter: a `*` in a scope is no pattern.
    let only = |path: &str| format!(":(top,literal){path}");
    let not = |path: &str| format!(":(top,exclude,literal){path}");
    // Git lists a commit when it changes a path that is asked for and not excluded, so one
    // that changes only housekeeping files is left out. A merge that changes nothing itself
    // is left out too.
    let mut paths: Vec<String> = HOUSEKEEPING.iter().map(|path| not(path)).collect();
    match scope {
        Scope::All => paths.push(":(top)".to_string()),
        Scope::Only(dir) => paths.push(only(dir)),
        Scope::Except(dir) => paths.extend([":(top)".to_string(), not(dir)]),
    }
    let from = format!("--since={since}T00:00:00");
    // `%cd` with this date format is the commit's day in local time, as `--since` reads a day.
    let mut args = vec!["log", rev.as_str(), "--date=format-local:%Y-%m-%d", "--format=%cd%x1f%h%x1f%s", from.as_str(), "--"];
    args.extend(paths.iter().map(String::as_str));
    // Git is not run while the cache is held: another report may read another repository meanwhile.
    let Some(out) = git(dir, &args) else { return Vec::new() };
    let commit = |line: &str| {
        let mut fields = line.split('\x1f').map(str::to_string);
        Some(Newest { date: fields.next()?, rev: fields.next()?, subject: fields.next()? })
    };
    let log: Vec<Newest> = String::from_utf8_lossy(&out).lines().filter_map(commit).collect();
    let mut logs = cache.lock().unwrap_or_else(PoisonError::into_inner);
    #[cfg(test)]
    {
        logs.read += 1;
    }
    logs.kept.insert(key, Kept { rev, since: since.to_string(), log: log.clone() });
    log
}

/// `~` and `~/…` as the home folder.
pub(crate) fn expand(path: &str) -> PathBuf {
    match (path.strip_prefix('~'), std::env::home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    }
}

/// The folders a folder name is looked up in, in the order of the lookup: each root, then
/// what is in it, two levels down. Folders that start with a dot and `node_modules` are
/// not looked into. Listed once per report, not once per `repos:` entry.
fn lookup_folders(roots: &[PathBuf]) -> Vec<PathBuf> {
    fn walk(dir: &Path, deeper: usize, folders: &mut Vec<PathBuf>) {
        folders.push(dir.to_path_buf());
        if deeper == 0 {
            return;
        }
        let Ok(inside) = std::fs::read_dir(dir) else { return };
        let mut inside: Vec<PathBuf> = inside.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        inside.sort();
        let skipped = |p: &PathBuf| p.file_name().and_then(|name| name.to_str()).is_none_or(|name| name.starts_with('.') || name == "node_modules");
        inside.iter().filter(|p| !skipped(p)).for_each(|p| walk(p, deeper - 1, folders));
    }
    let mut folders = Vec::new();
    roots.iter().for_each(|root| walk(root, 2, &mut folders));
    folders
}

/// The folder a `repos:` entry names: the path itself, or the first folder of that name
/// in `folders` (`lookup_folders`), which is at most three levels under a root
/// (`root/name`, `root/a/name`, `root/a/b/name`).
// The script's own walk stops one level sooner than its description says (`root/a/name`);
// this follows the description.
fn find_repo(entry: &str, folders: &[PathBuf]) -> Option<PathBuf> {
    let path = expand(entry);
    if path.is_absolute() {
        return path.is_dir().then_some(path);
    }
    folders.iter().map(|folder| folder.join(entry)).find(|found| found.is_dir())
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
        // A scope is part of the entry.
        assert_eq!(read("---\nrepos: [charts:!docs]\n---\n").0, ["charts:!docs"]);
        assert_eq!(read("---\nrepos:\n  - charts:api\n---\n").0, ["charts:api"]);
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
        let folders = lookup_folders(&[dir.path().join("missing"), dir.path().join("one"), dir.path().join("two")]);
        let found = |entry: &str| find_repo(entry, &folders).map(|p| p.strip_prefix(dir.path()).unwrap().to_string_lossy().into_owned());
        assert_eq!(found("top").as_deref(), Some("one/top"));
        assert_eq!(found("mid").as_deref(), Some("one/a/mid"));
        assert_eq!(found("deep").as_deref(), Some("one/a/b/deep"));
        assert_eq!(found("other").as_deref(), Some("two/other"));
        for entry in ["lost", "dotted", "pkg", "nope"] {
            assert_eq!(found(entry), None, "{entry}");
        }
        // A path is taken as it is, and is not looked up.
        let absolute = dir.path().join("one/a/b/c/lost");
        assert_eq!(find_repo(absolute.to_str().unwrap(), &folders), Some(absolute));
        assert_eq!(find_repo(dir.path().join("nope").to_str().unwrap(), &folders), None);
    }

    /// Plain git in `dir`, as the one who prepares a repository, with commits dated noon of `day`.
    fn git_on(dir: &Path, day: &str, args: &[&str]) {
        let config = ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "user.name=Ana", "-c", "user.email=ana@example.com"];
        let date = format!("{day}T12:00:00");
        let dates = [("GIT_AUTHOR_DATE", &date), ("GIT_COMMITTER_DATE", &date)];
        let output = std::process::Command::new("git").current_dir(dir).args(config).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").envs(dates).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    }

    /// A commit on `day` that writes `files`, with `subject`.
    fn commit(dir: &Path, day: &str, files: &[&str], subject: &str) {
        for file in files {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!("{subject} on {day}\n")).unwrap();
        }
        git_on(dir, day, &["add", "-A"]);
        git_on(dir, day, &["commit", "-q", "-m", subject]);
    }

    /// A new repository at `dir` with a first commit on 2026-03-01.
    fn repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git_on(dir, "2026-03-01", &["init", "-q"]);
        commit(dir, "2026-03-01", &["main.rs"], "first");
    }

    /// The report for one note updated on 2026-03-02 with `entry` in its `repos:`, as
    /// `(commits, subject of the newest)` when it is stale, and whether it could be checked.
    fn checked(entry: &str, roots: &Path) -> (Option<(usize, String)>, bool) {
        let notes = vec![("note.md".to_string(), vec![entry.to_string()], Some("2026-03-02".to_string()))];
        let health = HealthCheck { broken: Vec::new(), orphans: Vec::new(), notes, roots: vec![roots.to_path_buf()], cache: Cache::default() }.run();
        (health.stale.first().map(|stale| (stale.commits, stale.newest.subject.clone())), health.unchecked.is_empty())
    }

    fn has_git() -> bool {
        std::process::Command::new("git").arg("--version").output().is_ok()
    }

    #[test]
    fn a_folder_inside_a_repository_is_not_taken_for_a_repository() {
        if !has_git() {
            return;
        }
        let roots = tempfile::tempdir().unwrap();
        let charts = roots.path().join("charts");
        repo(&charts);
        commit(&charts, "2026-03-05", &["payment-service/Chart.yaml"], "chart");
        assert_eq!(checked("charts", roots.path()), (Some((1, "chart".to_string())), true));
        // Found by its name, and by its path: neither is the repository's root.
        assert_eq!(checked("payment-service", roots.path()), (None, false));
        assert_eq!(checked(charts.join("payment-service").to_str().unwrap(), roots.path()), (None, false));
        // With a scope the folder is named as part of its repository.
        assert_eq!(checked("charts:payment-service", roots.path()), (Some((1, "chart".to_string())), true));
    }

    #[test]
    fn only_commits_on_the_default_branch_make_a_note_stale() {
        if !has_git() {
            return;
        }
        let roots = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (origin, clone) = (outside.path().join("origin"), roots.path().join("app"));
        repo(&origin);
        git_on(roots.path(), "2026-03-01", &["clone", "-q", origin.to_str().unwrap(), "app"]);
        // A feature branch, checked out and with a commit: `origin/HEAD` has none.
        git_on(&clone, "2026-03-05", &["checkout", "-q", "-b", "feature"]);
        commit(&clone, "2026-03-05", &["feature.rs"], "feature");
        assert_eq!(checked("app", roots.path()), (None, true));
        // A commit on the default branch counts once it is fetched, whatever is checked out.
        commit(&origin, "2026-03-06", &["main.rs"], "on main");
        assert_eq!(checked("app", roots.path()), (None, true));
        git_on(&clone, "2026-03-06", &["fetch", "-q"]);
        assert_eq!(checked("app", roots.path()), (Some((1, "on main".to_string())), true));

        // Without `origin/HEAD` the checked-out commit is the default branch.
        let local = roots.path().join("local");
        repo(&local);
        git_on(&local, "2026-03-05", &["checkout", "-q", "-b", "feature"]);
        commit(&local, "2026-03-05", &["feature.rs"], "feature");
        git_on(&local, "2026-03-05", &["checkout", "-q", "main"]);
        assert_eq!(checked("local", roots.path()), (None, true));
        commit(&local, "2026-03-07", &["main.rs"], "local main");
        assert_eq!(checked("local", roots.path()), (Some((1, "local main".to_string())), true));
    }

    #[test]
    fn a_repository_whose_default_branch_did_not_move_is_not_read_again() {
        if !has_git() {
            return;
        }
        let roots = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let app = roots.path().join("app");
        repo(&app);
        commit(&app, "2026-03-05", &["api/a.rs"], "a");
        let cache = Cache::default();
        // The report for one note, as `(commits, subject of the newest)`, and how many times `git log` has run by then.
        let report = |entry: &str, updated: &str| {
            let notes = vec![("note.md".to_string(), vec![entry.to_string()], Some(updated.to_string()))];
            let health = HealthCheck { broken: Vec::new(), orphans: Vec::new(), notes, roots: vec![roots.path().to_path_buf()], cache: cache.clone() }.run();
            (health.stale.first().map(|stale| (stale.commits, stale.newest.subject.clone())), cache.lock().unwrap().read)
        };
        let stale = |commits: usize, subject: &str| Some((commits, subject.to_string()));
        assert_eq!(report("app", "2026-03-02"), (stale(1, "a"), 1));
        assert_eq!(report("app", "2026-03-02"), (stale(1, "a"), 1));
        // A later day is answered from what is kept, an earlier one is not in it.
        assert_eq!(report("app", "2026-03-04"), (stale(1, "a"), 1));
        assert_eq!(report("app", "2026-03-05"), (None, 1));
        assert_eq!(report("app", "2026-02-01"), (stale(2, "a"), 2));
        assert_eq!(report("app", "2026-03-02"), (stale(1, "a"), 2));
        // Each scope is kept by itself.
        assert_eq!(report("app:api", "2026-03-02"), (stale(1, "a"), 3));
        assert_eq!(report("app:!api", "2026-03-02"), (None, 4));
        assert_eq!(report("app:api", "2026-03-02"), (stale(1, "a"), 4));
        // A new commit is seen at the next report, in every scope.
        commit(&app, "2026-03-07", &["web/b.ts"], "b");
        assert_eq!(report("app", "2026-03-02"), (stale(2, "b"), 5));
        assert_eq!(report("app:!api", "2026-03-02"), (stale(1, "b"), 6));
        assert_eq!(report("app:api", "2026-03-02"), (stale(1, "a"), 7));
        assert_eq!(report("app", "2026-03-02"), (stale(2, "b"), 7));

        // A clone is known by `origin/HEAD`: a commit on what is checked out does not make it read again, a fetch does.
        let (origin, clone) = (outside.path().join("origin"), roots.path().join("cloned"));
        repo(&origin);
        git_on(roots.path(), "2026-03-01", &["clone", "-q", origin.to_str().unwrap(), "cloned"]);
        assert_eq!(report("cloned", "2026-03-02"), (None, 8));
        git_on(&clone, "2026-03-05", &["checkout", "-q", "-b", "feature"]);
        commit(&clone, "2026-03-05", &["feature.rs"], "feature");
        assert_eq!(report("cloned", "2026-03-02"), (None, 8));
        commit(&origin, "2026-03-06", &["main.rs"], "on main");
        git_on(&clone, "2026-03-06", &["fetch", "-q"]);
        assert_eq!(report("cloned", "2026-03-02"), (stale(1, "on main"), 9));
        assert_eq!(report("cloned", "2026-03-02"), (stale(1, "on main"), 9));
    }

    #[test]
    fn notes_of_different_days_that_name_one_repository_each_get_their_own_count() {
        if !has_git() {
            return;
        }
        let roots = tempfile::tempdir().unwrap();
        let app = roots.path().join("app");
        repo(&app);
        commit(&app, "2026-03-05", &["a.rs"], "a");
        commit(&app, "2026-03-07", &["b.rs"], "b");
        let note = |updated: &str| (format!("{updated}.md"), vec!["app".to_string()], Some(updated.to_string()));
        let notes = ["2026-03-06", "2026-02-01", "2026-03-07", "2026-03-04"].map(note).to_vec();
        let health = HealthCheck { broken: Vec::new(), orphans: Vec::new(), notes, roots: vec![roots.path().to_path_buf()], cache: Cache::default() }.run();
        let stale: Vec<(&str, usize, &str)> = health.stale.iter().map(|stale| (stale.updated.as_str(), stale.commits, stale.newest.subject.as_str())).collect();
        assert_eq!(stale, [("2026-03-06", 1, "b"), ("2026-02-01", 3, "b"), ("2026-03-04", 2, "b")]);
    }

    #[test]
    fn a_scope_counts_the_commits_under_a_folder_or_outside_it() {
        assert!(scoped("app") == ("app", Scope::All));
        assert!(scoped("app:api/v2/") == ("app", Scope::Only("api/v2".to_string())));
        assert!(scoped("~/work/app:!docs") == ("~/work/app", Scope::Except("docs".to_string())));
        assert!(scoped("app:") == ("app", Scope::All) && scoped("app:!") == ("app", Scope::All));
        assert!(scoped("C:\\code\\app") == ("C:\\code\\app", Scope::All));
        if !has_git() {
            return;
        }
        let roots = tempfile::tempdir().unwrap();
        let app = roots.path().join("app");
        repo(&app);
        commit(&app, "2026-03-05", &["api/a.rs"], "api");
        commit(&app, "2026-03-06", &["docs/b.md"], "docs");
        commit(&app, "2026-03-07", &["api/c.rs", "docs/c.md"], "both");
        let found = |entry: &str| checked(entry, roots.path());
        assert_eq!(found("app"), (Some((3, "both".to_string())), true));
        assert_eq!(found("app:api"), (Some((2, "both".to_string())), true));
        assert_eq!(found("app:docs/b.md"), (Some((1, "docs".to_string())), true));
        assert_eq!(found("app:!api"), (Some((2, "both".to_string())), true));
        assert_eq!(found("app:!docs"), (Some((2, "both".to_string())), true));
        // A folder nothing changed in, one that is no pattern, and one that is not there.
        assert_eq!(found("app:a*"), (None, true));
        assert_eq!(found("app:web"), (None, true));
        // The scope does not help to find the repository.
        assert_eq!(found("nope:!api"), (None, false));
    }

    #[test]
    fn a_commit_of_housekeeping_files_alone_makes_no_note_stale() {
        if !has_git() {
            return;
        }
        let roots = tempfile::tempdir().unwrap();
        let app = roots.path().join("app");
        repo(&app);
        commit(&app, "2026-03-05", HOUSEKEEPING, "housekeeping");
        assert_eq!(checked("app", roots.path()), (None, true));
        assert_eq!(checked("app:!docs", roots.path()), (None, true));
        // With code in the same commit it counts, and so does a file of that name in a folder.
        commit(&app, "2026-03-06", &[".gitignore", "main.rs"], "code too");
        assert_eq!(checked("app", roots.path()), (Some((1, "code too".to_string())), true));
        commit(&app, "2026-03-07", &["web/.gitignore"], "inside web");
        assert_eq!(checked("app", roots.path()), (Some((2, "inside web".to_string())), true));
    }
}
