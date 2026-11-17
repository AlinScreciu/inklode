//! Claims: lines of a note that name the evidence for what they say, in an HTML comment
//! at the end of the line, and the last result of checking that evidence.
//!
//! ```text
//! 45 core tests pass. <!-- check: cargo test -p core @ ~/code/myproject -->
//! The spec is in the vault. <!-- check: file Notes/Spec.md -->
//! Docs are online. <!-- check: https://tauri.app -->
//! ```
//!
//! The text after `check:` decides the kind of evidence:
//! - `file <path>`: the file exists. The path is relative to the vault, or `~/…`, or absolute.
//! - `http://…` or `https://…`: a GET that follows redirects ends in a 2xx within 10 s.
//! - anything else: a shell command that exits with status 0 within two minutes. ` @ <dir>`
//!   at its end names the folder it runs in; without it that is the vault's folder.
//!
//! A marker in a fenced code block or in inline code is not a claim.
//!
//! Listing reads the notes, the results and the files that `file` claims name. It runs no
//! command and fetches no URL. Only `check` does, for one claim, and a command only when
//! its caller says that commands are allowed: a note can come from someone else, and its
//! commands would run as the user. The hosts decide that (src-tauri/src/lib.rs), not this file.
//!
//! The results are kept in a file of the host's state folder, one per vault, like the
//! review inbox's. A check never writes into the vault.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::health::expand;
use crate::index::unfenced;
use crate::review::digest;
use crate::{Error, Vault};

/// How long a command may run.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(120);
/// A check that passed longer ago than this, in seconds, is stale.
const MAX_AGE: u64 = 30 * 86_400;
/// How many characters of a check's output are kept.
const OUTPUT: usize = 2000;

/// One claim with the result of its last check.
#[derive(Serialize, Debug)]
pub struct Entry {
    pub path: String,
    /// From 1.
    pub line: usize,
    /// The line without its marker, trimmed and cut at 200 characters.
    pub text: String,
    /// What the marker has after `check:`.
    pub evidence: String,
    /// `command`, `file` or `url`.
    pub kind: &'static str,
    /// `unchecked`: never checked. `failing`: the last check failed. `stale`: it passed, but
    /// more than 30 days ago, or the file changed since or is gone. `passing`: otherwise.
    pub status: &'static str,
    /// The day of the last check, `YYYY-MM-DD`.
    pub checked: Option<String>,
    /// What the last check printed or why it failed, at most the last 2000 characters.
    pub output: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Evidence<'a> {
    Command { run: &'a str, dir: Option<&'a str> },
    File(&'a str),
    Url(&'a str),
}

impl Evidence<'_> {
    fn kind(&self) -> &'static str {
        match self {
            Evidence::Command { .. } => "command",
            Evidence::File(_) => "file",
            Evidence::Url(_) => "url",
        }
    }
}

/// The evidence a marker names, from its text after `check:`.
// shortcut: the last ` @ ` of a command always starts its folder, so a command that has
// ` @ ` in it for another reason cannot be written without one; add an escape if one is needed
fn evidence(text: &str) -> Evidence<'_> {
    let path = text.strip_prefix("file").filter(|rest| rest.starts_with(char::is_whitespace)).map(str::trim);
    if let Some(path) = path.filter(|path| !path.is_empty()) {
        return Evidence::File(path);
    }
    if text.starts_with("http://") || text.starts_with("https://") {
        return Evidence::Url(text);
    }
    match text.rsplit_once(" @ ").map(|(run, dir)| (run.trim(), dir.trim())) {
        Some((run, dir)) if !run.is_empty() && !dir.is_empty() => Evidence::Command { run, dir: Some(dir) },
        _ => Evidence::Command { run: text, dir: None },
    }
}

/// A claim as it stands in a note.
struct Claim<'a> {
    line: usize,
    /// The whole line without its line ending: with the note's path, what the claim is known by.
    full: &'a str,
    /// The line before the marker.
    before: &'a str,
    /// The marker's text after `check:`, trimmed.
    evidence: &'a str,
}

/// The claim on one line: a line that ends with `<!-- check: … -->`, the marker not in inline code.
fn claim(line: usize, text: &str) -> Option<Claim<'_>> {
    let full = text.trim_end_matches(['\n', '\r']);
    let inside = full.trim_end().strip_suffix("-->")?;
    let start = inside.rfind("<!--")?;
    let evidence = inside[start + 4..].trim().strip_prefix("check:")?.trim();
    if evidence.is_empty() || in_code(full, start) {
        return None;
    }
    Some(Claim { line, full, before: &full[..start], evidence })
}

/// Whether the byte offset `at` of `line` is inside inline code, read as the index reads it for links.
fn in_code(line: &str, at: usize) -> bool {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < at {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        // Inline code runs to the next run of as many backticks.
        let ticks = bytes[i..].iter().take_while(|b| **b == b'`').count();
        i += ticks;
        if let Some(close) = line[i..].find(&"`".repeat(ticks)) {
            i += close + ticks;
            if i > at {
                return true;
            }
        }
    }
    false
}

/// The claims of a note, outside fenced code blocks.
fn claims(content: &str) -> impl Iterator<Item = Claim<'_>> {
    unfenced(content).filter_map(|(line, _, text)| claim(line, text))
}

/// The result of a claim's last check.
#[derive(Serialize, Deserialize, Clone)]
struct Checked {
    /// When, in seconds since 1970.
    at: u64,
    passed: bool,
    output: Option<String>,
    /// For a file that was there: the digest of its content.
    hash: Option<String>,
}

/// The results of one vault.
#[derive(Serialize, Deserialize, Default)]
struct State {
    /// The vault's folder, for a person who reads the file.
    vault: String,
    /// By note path, then by the claim's whole line.
    // shortcut: a claim is known by its note's path and its whole line, so a line that was
    // edited, and every claim of a note that was renamed or moved, counts as never checked,
    // and two equal lines of one note share a result; keep an id in the marker if the
    // history of a claim has to survive an edit
    results: BTreeMap<String, BTreeMap<String, Checked>>,
}

fn state_file(dir: &Path, root: &Path) -> PathBuf {
    dir.join("claims").join(digest(root.as_os_str().as_encoded_bytes()) + ".json")
}

/// The vault's results. A file that is missing or cannot be read as a state is none.
fn load(dir: &Path, root: &Path) -> State {
    fs::read(state_file(dir, root)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// Writes through a temporary file and a rename, like `Vault::write`.
fn save(dir: &Path, root: &Path, state: &State) -> Result<(), Error> {
    let path = state_file(dir, root);
    let failed = |e: std::io::Error| Error::Io(path.display().to_string(), e);
    fs::create_dir_all(path.parent().expect("the file is in a folder")).map_err(failed)?;
    let tmp = path.with_extension("json.inklode-tmp");
    fs::write(&tmp, serde_json::to_string_pretty(state).expect("a state is plain JSON") + "\n").map_err(failed)?;
    fs::rename(&tmp, &path).map_err(failed)
}

/// Where a `file` claim's path is: in the vault, unless it is `~/…` or absolute.
fn file_at(root: &Path, path: &str) -> PathBuf {
    root.join(expand(path))
}

/// The most a `file` claim's file may hold.
const MAX_FILE: u64 = 64 * 1024 * 1024;

/// The bytes of a `file` claim's file, or why it is no evidence: only a regular file of at
/// most `MAX_FILE` bytes is read. A symbolic link is followed: the path is the user's own.
/// A device (`/dev/zero`) or a FIFO would never end, so neither is read.
fn file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut options = fs::File::options();
    options.read(true);
    // A FIFO without a writer opens at once this way, and is then seen not to be a file.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK);
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("no such file".to_string()),
        Err(e) => return Err(e.to_string()),
    };
    // Asked of the open file, so it is about what will be read.
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    let too_large = || format!("larger than {} MB, the most a file claim reads", MAX_FILE / (1024 * 1024));
    if meta.len() > MAX_FILE {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    // The limit holds also for a file that grows while it is read.
    file.take(MAX_FILE + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE { Err(too_large()) } else { Ok(bytes) }
}

/// The day of a time in seconds since 1970, as `YYYY-MM-DD`.
// shortcut: the day in UTC, so a check late in the evening west of Greenwich, or early in the
// morning east of it, shows the neighbouring day; use the local offset if that confuses
fn day(seconds: u64) -> String {
    // Days to a date of the Gregorian calendar, counted in 400-year eras that start on 1 March.
    let days = (seconds / 86_400) as i64 + 719_468;
    let (era, of_era) = (days.div_euclid(146_097), days.rem_euclid(146_097));
    let year_of_era = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * of_year + 2) / 153;
    let date = of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 { month_from_march + 3 } else { month_from_march - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{date:02}")
}

/// The claim as it is listed. `now` is in seconds since 1970.
// shortcut: a passing `file` claim's file is read whole at every listing to see whether it
// changed; compare its size and time first if a vault with many or large ones lists slowly
fn entry(root: &Path, path: &str, claim: &Claim, checked: Option<&Checked>, now: u64) -> Entry {
    let evidence = evidence(claim.evidence);
    let status = match checked {
        None => "unchecked",
        Some(checked) if !checked.passed => "failing",
        Some(checked) if now.saturating_sub(checked.at) > MAX_AGE => "stale",
        Some(checked) => match evidence {
            Evidence::File(file) if file_bytes(&file_at(root, file)).ok().map(|bytes| digest(&bytes)) != checked.hash => "stale",
            _ => "passing",
        },
    };
    Entry {
        path: path.to_string(),
        line: claim.line,
        text: claim.before.trim().chars().take(200).collect(),
        evidence: claim.evidence.to_string(),
        kind: evidence.kind(),
        status,
        checked: checked.map(|checked| day(checked.at)),
        output: checked.and_then(|checked| checked.output.clone()),
    }
}

/// Every claim of `notes` (`(path, text)`, sorted by path) with its last result, by path
/// then line. Reads only.
pub fn list<'a>(dir: &Path, root: &Path, notes: impl Iterator<Item = (&'a str, &'a str)>, now: u64) -> Vec<Entry> {
    let state = load(dir, root);
    let mut entries = Vec::new();
    for (path, content) in notes {
        let results = state.results.get(path);
        entries.extend(claims(content).map(|claim| entry(root, path, &claim, results.and_then(|results| results.get(claim.full)), now)));
    }
    entries
}

/// One check at a time changes the state file: two that finish together would each write
/// the file without the other's result.
static SAVING: Mutex<()> = Mutex::new(());

/// Checks the claim on line `line` of the note at `path`, keeps the result and returns the
/// claim as `list` would. A command runs only with `commands`; without, such a claim is
/// refused before anything runs. `now` is in seconds since 1970, `timeout` what a command gets.
pub fn check(dir: &Path, vault: &Vault, path: &str, line: usize, commands: bool, now: u64, timeout: Duration) -> Result<Entry, Error> {
    let root = vault.root();
    let content = vault.read(path)?;
    let claim = claims(&content).find(|claim| claim.line == line).ok_or_else(|| Error::NoClaim(path.to_string(), line))?;
    let (passed, output, hash) = match evidence(claim.evidence) {
        Evidence::Command { .. } if !commands => return Err(Error::CommandsRefused),
        Evidence::Command { run, dir: folder } => {
            let folder = folder.map_or_else(|| root.to_path_buf(), |folder| file_at(root, folder));
            let (passed, output) = run_command(dir, run, &folder, timeout)?;
            (passed, Some(output), None)
        }
        Evidence::File(file) => match file_bytes(&file_at(root, file)) {
            Ok(bytes) => (true, None, Some(digest(&bytes))),
            Err(why) => (false, Some(why), None),
        },
        Evidence::Url(url) => {
            let (passed, output) = fetch(url);
            (passed, Some(output), None)
        }
    };
    let checked = Checked { at: now, passed, output, hash };

    let _saving = SAVING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut state = load(dir, root);
    state.vault = root.display().to_string();
    state.results.entry(path.to_string()).or_default().insert(claim.full.to_string(), checked.clone());
    // What is kept for claims that are no longer in their note goes.
    state.results.retain(|path, results| {
        let content = vault.read(path).unwrap_or_default();
        let there: HashSet<&str> = claims(&content).map(|claim| claim.full).collect();
        results.retain(|line, _| there.contains(line.as_str()));
        !results.is_empty()
    });
    save(dir, root, &state)?;
    Ok(entry(root, path, &claim, Some(&checked), now))
}

/// The last `count` characters of `text`.
fn tail(text: &str, count: usize) -> &str {
    let skipped = text.chars().count().saturating_sub(count);
    &text[text.char_indices().nth(skipped).map_or(text.len(), |(at, _)| at)..]
}

/// Runs `command` with `/bin/sh -c` in `folder` and says whether it exited with status 0
/// in time, and how it ended with the end of what it printed. What it prints goes to a
/// file in the state folder while it runs.
// The command gets the process's environment. The desktop app sets `PATH` from the user's login
// shell at start (`path_from_shell` in src-tauri/src/lib.rs), so `cargo` and Homebrew are found.
fn run_command(dir: &Path, command: &str, folder: &Path, timeout: Duration) -> Result<(bool, String), Error> {
    static RUNS: AtomicU64 = AtomicU64::new(0);
    let printed = dir.join("claims").join(format!("run-{}-{}.out", std::process::id(), RUNS.fetch_add(1, Ordering::Relaxed)));
    let failed = |e: std::io::Error| Error::Io(printed.display().to_string(), e);
    fs::create_dir_all(dir.join("claims")).map_err(failed)?;
    // A file and not a pipe: a process the command left behind would keep a pipe open, and
    // reading it would not end.
    let file = fs::File::create(&printed).map_err(failed)?;
    let mut sh = Command::new("/bin/sh");
    sh.arg("-c").arg(command).current_dir(folder).stdin(Stdio::null()).stdout(file.try_clone().map_err(failed)?).stderr(file);
    // A process group of its own, so that on a timeout everything the command started can be ended with it.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut sh, 0);
    let ended = match sh.spawn() {
        Err(e) => Err(format!("could not run in {}: {e}", folder.display())),
        Ok(mut child) => {
            let deadline = Instant::now() + timeout;
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                    _ => break None,
                }
            };
            if status.is_none() {
                // SAFETY: `kill` takes two numbers. The child was not waited for, so its id is
                // still its own, and the id of the group it leads.
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
            }
            Ok(status)
        }
    };
    // The end of the file is enough: a character is at most four bytes.
    let mut end = Vec::new();
    if let Ok(mut file) = fs::File::open(&printed) {
        let length = file.metadata().map_or(0, |meta| meta.len());
        let _ = file.seek(SeekFrom::Start(length.saturating_sub(4 * OUTPUT as u64)));
        let _ = file.read_to_end(&mut end);
    }
    let _ = fs::remove_file(&printed);
    let (passed, how) = match ended {
        Err(why) => (false, why),
        Ok(None) => (false, format!("timed out after {timeout:?}")),
        Ok(Some(status)) => (status.success(), status.code().map_or_else(|| status.to_string(), |code| format!("exit status {code}"))),
    };
    let end = String::from_utf8_lossy(&end);
    let end = tail(end.trim(), OUTPUT - how.chars().count().min(OUTPUT - 1) - 1);
    Ok((passed, if end.is_empty() { how } else { format!("{how}\n{end}") }))
}

/// Whether a GET of `url` ends in a 2xx, redirects followed, within 10 s, and the status or why not.
// shortcut: `/usr/bin/curl` does the request, as `git` does the history; use an HTTP crate
// if the app has to run where there is no curl
fn fetch(url: &str) -> (bool, String) {
    let curl = Command::new("/usr/bin/curl")
        // `-q` first: no `~/.curlrc`. Only http and https, also after a redirect, and no `[1-9]` or `{a,b}` in the URL read as many URLs.
        .args(["-q", "--silent", "--show-error", "--location", "--globoff", "--proto", "=http,https", "--proto-redir", "=http,https"])
        .args(["--max-time", "10", "--output", "/dev/null", "--write-out", "%{http_code}"])
        // Never taken for an option: it starts with `http`.
        .arg(url)
        .stdin(Stdio::null())
        .output();
    match curl {
        Err(e) => (false, format!("could not run /usr/bin/curl: {e}")),
        Ok(out) if out.status.success() => {
            let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (code.len() == 3 && code.starts_with('2'), format!("HTTP {code}"))
        }
        Ok(out) => {
            let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
            (false, if why.is_empty() { out.status.to_string() } else { tail(&why, OUTPUT).to_string() })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::index::Index;

    /// A day in seconds, and a moment to call now.
    const DAY: u64 = 86_400;
    const NOW: u64 = 1_795_000_000;

    /// A vault with `notes`, and a state folder.
    fn vault(notes: &[(&str, &str)]) -> (tempfile::TempDir, tempfile::TempDir, Vault) {
        let (dir, state) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        for (path, text) in notes {
            fs::create_dir_all(dir.path().join(path).parent().unwrap()).unwrap();
            fs::write(dir.path().join(path), text).unwrap();
        }
        let vault = Vault::open(dir.path()).unwrap();
        (dir, state, vault)
    }

    fn listed(state: &tempfile::TempDir, vault: &Vault, now: u64) -> Vec<Entry> {
        let index = Index::build(vault).unwrap();
        list(state.path(), vault.root(), index.texts(), now)
    }

    /// `(line, status)` of every claim.
    fn statuses(state: &tempfile::TempDir, vault: &Vault, now: u64) -> Vec<(usize, &'static str)> {
        listed(state, vault, now).iter().map(|entry| (entry.line, entry.status)).collect()
    }

    /// Every file under `dir` with its bytes, and every folder.
    fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        let mut found = BTreeMap::new();
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(snapshot(&path));
                found.insert(path, None);
            } else {
                found.insert(path.clone(), Some(fs::read(&path).unwrap()));
            }
        }
        found
    }

    #[test]
    fn the_three_kinds_of_evidence_and_the_folder_of_a_command() {
        assert_eq!(evidence("file Notes/Spec.md"), Evidence::File("Notes/Spec.md"));
        assert_eq!(evidence("file   ~/x.txt"), Evidence::File("~/x.txt"));
        assert_eq!(evidence("https://tauri.app"), Evidence::Url("https://tauri.app"));
        assert_eq!(evidence("http://localhost:1/x"), Evidence::Url("http://localhost:1/x"));
        assert_eq!(evidence("cargo test -p core @ ~/code/myproject"), Evidence::Command { run: "cargo test -p core", dir: Some("~/code/myproject") });
        assert_eq!(evidence("cargo test"), Evidence::Command { run: "cargo test", dir: None });
        // The last ` @ ` is the folder's.
        assert_eq!(evidence("echo a @ b @ /tmp"), Evidence::Command { run: "echo a @ b", dir: Some("/tmp") });
        // Not a file claim and not a URL: commands.
        assert_eq!(evidence("file"), Evidence::Command { run: "file", dir: None });
        assert_eq!(evidence("filename --check"), Evidence::Command { run: "filename --check", dir: None });
        assert_eq!(evidence("ftp://x"), Evidence::Command { run: "ftp://x", dir: None });
        assert_eq!(evidence("echo a @b"), Evidence::Command { run: "echo a @b", dir: None });
    }

    #[test]
    fn claims_are_lines_that_end_with_a_marker_outside_code() {
        let long = "x".repeat(300);
        let note = format!(
            "# Title\n\
             45 tests pass.  <!-- check: cargo test @ ~/code -->\n\
             - The spec is there. <!--check:file Plans/Spec.md-->  \r\n\
             Docs are online. <!-- check: https://tauri.app -->\n\
             ```\n\
             In a fence. <!-- check: rm -rf / -->\n\
             ```\n\
             ~~~sh\n\
             In a fence. <!-- check: file a.md -->\n\
             ~~~\n\
             `In code. <!-- check: file a.md -->`\n\
             ``In code. <!-- check: echo ` -->`` <!-- not a marker -->\n\
             `code` then a claim with `ticks`. <!-- check: echo `date` -->\n\
             A marker <!-- check: file a.md --> that does not end the line.\n\
             Another comment. <!-- todo: check -->\n\
             Nothing named. <!-- check: -->\n\
             {long} <!-- check: true -->\n\
             <!-- check: file a.md -->"
        );
        let found: Vec<(usize, String, &str, &'static str)> = claims(&note)
            .map(|claim| {
                let entry = entry(Path::new("/nowhere"), "a.md", &claim, None, NOW);
                (entry.line, entry.text, claim.evidence, entry.kind)
            })
            .collect();
        assert_eq!(
            found,
            [
                (2, "45 tests pass.".to_string(), "cargo test @ ~/code", "command"),
                (3, "- The spec is there.".to_string(), "file Plans/Spec.md", "file"),
                (4, "Docs are online.".to_string(), "https://tauri.app", "url"),
                (13, "`code` then a claim with `ticks`.".to_string(), "echo `date`", "command"),
                (17, "x".repeat(200), "true", "command"),
                (18, String::new(), "file a.md", "file"),
            ]
        );
        // The whole line is what the claim is known by, without its line ending.
        assert_eq!(claims(&note).nth(1).unwrap().full, "- The spec is there. <!--check:file Plans/Spec.md-->  ");
    }

    #[test]
    fn the_day_of_a_time() {
        assert_eq!(day(0), "1970-01-01");
        assert_eq!(day(951_782_399), "2000-02-28");
        assert_eq!(day(951_782_400), "2000-02-29");
        assert_eq!(day(1_795_000_000), "2026-11-18");
        assert_eq!(day(1_798_761_599), "2026-12-31");
        assert_eq!(day(1_798_761_600), "2027-01-01");
    }

    #[test]
    fn a_claim_is_unchecked_failing_passing_or_stale() {
        let note = "Spec. <!-- check: file spec.txt -->\nGone. <!-- check: file nope.txt -->\nTrue. <!-- check: true -->\nNever. <!-- check: true -->\n";
        let (dir, state, vault) = vault(&[("a.md", note), ("spec.txt", "one")]);
        assert_eq!(statuses(&state, &vault, NOW), [(1, "unchecked"), (2, "unchecked"), (3, "unchecked"), (4, "unchecked")]);
        let unchecked = &listed(&state, &vault, NOW)[0];
        assert_eq!((&unchecked.checked, &unchecked.output), (&None, &None));

        let run = |line: usize, now: u64| check(state.path(), &vault, "a.md", line, true, now, TIMEOUT).unwrap();
        let spec = run(1, NOW);
        assert_eq!((spec.status, spec.checked.as_deref(), spec.output.as_deref()), ("passing", Some("2026-11-18"), None));
        let gone = run(2, NOW);
        assert_eq!((gone.status, gone.checked.as_deref(), gone.output.as_deref()), ("failing", Some("2026-11-18"), Some("no such file")));
        assert_eq!(run(3, NOW).status, "passing");
        assert_eq!(statuses(&state, &vault, NOW), [(1, "passing"), (2, "failing"), (3, "passing"), (4, "unchecked")]);

        // Thirty days old is not stale, a second more is. A failing claim stays failing.
        assert_eq!(statuses(&state, &vault, NOW + 30 * DAY), [(1, "passing"), (2, "failing"), (3, "passing"), (4, "unchecked")]);
        assert_eq!(statuses(&state, &vault, NOW + 30 * DAY + 1), [(1, "stale"), (2, "failing"), (3, "stale"), (4, "unchecked")]);

        // The file has another content than when it was checked, the same again, and is gone.
        fs::write(dir.path().join("spec.txt"), "two").unwrap();
        assert_eq!(statuses(&state, &vault, NOW)[0], (1, "stale"));
        fs::write(dir.path().join("spec.txt"), "one").unwrap();
        assert_eq!(statuses(&state, &vault, NOW)[0], (1, "passing"));
        fs::remove_file(dir.path().join("spec.txt")).unwrap();
        assert_eq!(statuses(&state, &vault, NOW)[0], (1, "stale"));
        // Checked again, it fails.
        assert_eq!(run(1, NOW + DAY).status, "failing");
    }

    #[test]
    fn a_file_claim_reaches_the_vault_the_home_folder_and_an_absolute_path() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("there.txt"), "x").unwrap();
        let note = format!("In. <!-- check: file sub/in.txt -->\nOut. <!-- check: file {} -->\nHome. <!-- check: file ~ -->\n", outside.path().join("there.txt").display());
        let (_dir, state, vault) = vault(&[("a.md", &note), ("sub/in.txt", "x")]);
        let run = |line: usize| check(state.path(), &vault, "a.md", line, false, NOW, TIMEOUT).unwrap();
        assert_eq!((run(1).status, run(2).status), ("passing", "passing"));
        // The home folder is there, and is no file.
        let home = run(3);
        assert_eq!(home.status, "failing");
        assert_eq!(home.output.as_deref(), Some("not a regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_claim_reads_only_a_regular_file_of_limited_size() {
        let (dir, state, vault) = vault(&[("a.md", "Zero. <!-- check: file /dev/zero -->\nPipe. <!-- check: file pipe -->\nBig. <!-- check: file big.bin -->\nLink. <!-- check: file link.txt -->\n"), ("real.txt", "x")]);
        let pipe = std::ffi::CString::new(dir.path().join("pipe").to_str().unwrap()).unwrap();
        // SAFETY: a valid, NUL-ended path.
        assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
        // A sparse file one byte over the limit: it takes no room on disk.
        fs::File::create(dir.path().join("big.bin")).unwrap().set_len(MAX_FILE + 1).unwrap();
        std::os::unix::fs::symlink("real.txt", dir.path().join("link.txt")).unwrap();
        let started = std::time::Instant::now();
        let run = |line: usize| check(state.path(), &vault, "a.md", line, false, NOW, TIMEOUT).unwrap();
        let (zero, pipe, big, link) = (run(1), run(2), run(3), run(4));
        assert_eq!((zero.status, zero.output.as_deref()), ("failing", Some("not a regular file")));
        assert_eq!((pipe.status, pipe.output.as_deref()), ("failing", Some("not a regular file")));
        assert_eq!((big.status, big.output.as_deref()), ("failing", Some("larger than 64 MB, the most a file claim reads")));
        assert_eq!(link.status, "passing");
        // Listing reads the files of passing claims again, and must not wait on a FIFO either.
        fs::remove_file(dir.path().join("link.txt")).unwrap();
        // SAFETY: as above.
        let fifo = std::ffi::CString::new(dir.path().join("link.txt").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(statuses(&state, &vault, NOW).last(), Some(&(4, "stale")));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_command_passes_on_status_zero_and_its_output_is_kept() {
        let other = tempfile::tempdir().unwrap();
        let note = format!(
            "Passes. <!-- check: echo out; echo err >&2 -->\n\
             Fails. <!-- check: echo before; exit 3 -->\n\
             Here. <!-- check: pwd -->\n\
             There. <!-- check: pwd @ {} -->\n\
             Nowhere. <!-- check: pwd @ /no/such/folder -->\n\
             Long. <!-- check: printf 'x%.0s' $(seq 1 5000); echo END -->\n\
             Reads. <!-- check: cat -->\n",
            other.path().display()
        );
        let (_dir, state, vault) = vault(&[("a.md", &note)]);
        let run = |line: usize| {
            let entry = check(state.path(), &vault, "a.md", line, true, NOW, TIMEOUT).unwrap();
            (entry.status, entry.output.unwrap())
        };
        assert_eq!(run(1), ("passing", "exit status 0\nout\nerr".to_string()));
        assert_eq!(run(2), ("failing", "exit status 3\nbefore".to_string()));
        assert_eq!(run(3), ("passing", format!("exit status 0\n{}", vault.root().display())));
        assert_eq!(run(4), ("passing", format!("exit status 0\n{}", fs::canonicalize(other.path()).unwrap().display())));
        let (status, output) = run(5);
        assert_eq!(status, "failing");
        assert!(output.starts_with("could not run in /no/such/folder: "), "{output}");
        // How it ended, then the end of what it printed, 2000 characters together.
        let (status, output) = run(6);
        assert_eq!((status, output.chars().count()), ("passing", 2000));
        assert!(output.starts_with("exit status 0\nxxx") && output.ends_with("xxxEND"), "{output}");
        // Nothing to read: stdin is closed.
        assert_eq!(run(7), ("passing", "exit status 0".to_string()));
        // What the commands printed was in files of the state folder, which are gone.
        let left: Vec<_> = fs::read_dir(state.path().join("claims")).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(left.len(), 1, "{left:?}");
    }

    #[test]
    fn a_command_that_takes_too_long_is_ended_with_what_it_started() {
        let marks = tempfile::tempdir().unwrap();
        let late = marks.path().join("late");
        let note = format!("Slow. <!-- check: echo started; (sleep 1; touch {}) & sleep 30 -->\n", late.display());
        let (_dir, state, vault) = vault(&[("a.md", &note)]);
        let before = Instant::now();
        let entry = check(state.path(), &vault, "a.md", 1, true, NOW, Duration::from_millis(300)).unwrap();
        assert!(before.elapsed() < Duration::from_secs(10));
        assert_eq!((entry.status, entry.output.as_deref()), ("failing", Some("timed out after 300ms\nstarted")));
        // The part of it that would have made the file a second in was ended too.
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!late.exists());
    }

    #[test]
    fn a_command_is_refused_unless_commands_are_allowed_and_nothing_runs() {
        let marks = tempfile::tempdir().unwrap();
        let mark = marks.path().join("ran");
        let note = format!("Runs. <!-- check: touch {} -->\nNo claim here.\n", mark.display());
        let (_dir, state, vault) = vault(&[("a.md", &note)]);
        let refused = check(state.path(), &vault, "a.md", 1, false, NOW, TIMEOUT).unwrap_err();
        assert_eq!(refused.to_string(), "commands are not allowed for this vault");
        assert!(!mark.exists());
        assert!(!state.path().join("claims").exists());
        assert_eq!(statuses(&state, &vault, NOW), [(1, "unchecked")]);

        // A line without a claim, a line that is not there, and a note that is not there.
        for (path, line) in [("a.md", 2), ("a.md", 0), ("a.md", 9)] {
            let error = check(state.path(), &vault, path, line, true, NOW, TIMEOUT).unwrap_err();
            assert_eq!(error.to_string(), format!("no claim on line {line} of {path}"));
        }
        assert!(check(state.path(), &vault, "nope.md", 1, true, NOW, TIMEOUT).is_err());

        assert_eq!(check(state.path(), &vault, "a.md", 1, true, NOW, TIMEOUT).unwrap().status, "passing");
        assert!(mark.exists());
    }

    #[test]
    fn results_are_kept_outside_the_vault_and_dropped_with_their_claim() {
        let note = "One. <!-- check: true -->\nTwo. <!-- check: file b.md -->\n```\nFenced. <!-- check: true -->\n```\n";
        let (dir, state, vault) = vault(&[("a.md", note), ("b.md", "Three. <!-- check: false -->\n"), (".inklode/settings.json", "{}\n")]);
        let before = snapshot(dir.path());
        let run = |path: &str, line: usize| check(state.path(), &vault, path, line, true, NOW, TIMEOUT).unwrap().status;
        assert_eq!((run("a.md", 1), run("a.md", 2), run("b.md", 1)), ("passing", "passing", "failing"));
        assert_eq!(snapshot(dir.path()), before);

        // One file for the vault, in `claims/` of the state folder, with the three results.
        let files: Vec<PathBuf> = fs::read_dir(state.path().join("claims")).unwrap().flatten().map(|entry| entry.path()).collect();
        assert_eq!(files.len(), 1, "{files:?}");
        let kept = || serde_json::from_slice::<serde_json::Value>(&fs::read(&files[0]).unwrap()).unwrap();
        assert_eq!(kept()["vault"], vault.root().to_str().unwrap());
        assert_eq!(kept()["results"]["a.md"].as_object().unwrap().len(), 2);
        assert_eq!(kept()["results"]["b.md"]["Three. <!-- check: false -->"]["passed"], false);

        // An edited line is another claim, never checked. Its old result goes at the next check, and so
        // does that of a note that is gone.
        fs::write(dir.path().join("a.md"), note.replace("One.", "One!")).unwrap();
        fs::remove_file(dir.path().join("b.md")).unwrap();
        assert_eq!(statuses(&state, &vault, NOW), [(1, "unchecked"), (2, "stale")]);
        assert_eq!(kept()["results"]["a.md"].as_object().unwrap().len(), 2);
        assert_eq!(run("a.md", 2), "failing");
        assert_eq!(kept()["results"], serde_json::json!({ "a.md": { "Two. <!-- check: file b.md -->": { "at": NOW, "passed": false, "output": "no such file", "hash": null } } }));
        // A line in a fence cannot be checked.
        assert!(matches!(check(state.path(), &vault, "a.md", 4, true, NOW, TIMEOUT), Err(Error::NoClaim(..))));
    }

    #[test]
    fn a_url_passes_on_a_2xx_after_redirects() {
        if !Path::new("/usr/bin/curl").exists() {
            return;
        }
        // A server that answers `/moved` with a redirect to `/ok`, `/ok` with 200 and the rest with 404.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut request = [0; 1024];
                let read = stream.read(&mut request).unwrap_or(0);
                let request = String::from_utf8_lossy(&request[..read]).into_owned();
                let answer = match request.split(' ').nth(1) {
                    Some("/ok") => "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    Some("/moved") => "HTTP/1.1 302 Found\r\nLocation: /ok\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    _ => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                };
                let _ = stream.write_all(answer.as_bytes());
            }
        });
        let note = format!(
            "Ok. <!-- check: http://127.0.0.1:{port}/ok -->\nMoved. <!-- check: http://127.0.0.1:{port}/moved -->\nMissing. <!-- check: http://127.0.0.1:{port}/nope -->\nRefused. <!-- check: http://127.0.0.1:1/ -->\n"
        );
        let (dir, state, vault) = vault(&[("a.md", &note)]);
        let before = snapshot(dir.path());
        // Without `commands`: a URL is not a command.
        let run = |line: usize| {
            let entry = check(state.path(), &vault, "a.md", line, false, NOW, TIMEOUT).unwrap();
            (entry.kind, entry.status, entry.output.unwrap())
        };
        assert_eq!(run(1), ("url", "passing", "HTTP 200".to_string()));
        assert_eq!(run(2), ("url", "passing", "HTTP 200".to_string()));
        assert_eq!(run(3), ("url", "failing", "HTTP 404".to_string()));
        let (_, status, output) = run(4);
        assert_eq!(status, "failing");
        assert!(output.starts_with("curl: "), "{output}");
        assert_eq!(snapshot(dir.path()), before);
    }
}
