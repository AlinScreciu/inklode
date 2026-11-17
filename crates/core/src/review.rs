//! The review inbox: the notes whose text changed since the user last looked, found by
//! asking git what differs between a remembered commit (`base`) and the files on disk.
//! Agents change notes by writing files and committing, also while the app is closed,
//! and this is how the user sees what they did.
//!
//! Git is only read (`rev-parse`, `cat-file`, `ls-tree`, `ls-files`, `log`), and it is never
//! asked to read a note from disk (git.rs says why): the committed text comes from
//! `cat-file`, the text on disk from our own read, and the two are compared here. What the user
//! has seen is kept in a file of the host's state folder, one per vault, never in the
//! vault: a state file there would itself show up as a change. Every operation reads
//! that file again, so the app and `inklode-mcp` agree when both have a vault open.
//!
//! A note the user accepted with a text other than the one at `base` is kept there with
//! that text. From then on the note is compared with it and not with `base`: it waits
//! when it differs from the accepted text, and that is the text a reject goes back to.
//!
//! A note that is missing counts as an empty one, as for `note.write`: a new note
//! without text is nothing to review.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::Error;
use crate::git::{Commit, FORMAT, blobs, commits, git};
use crate::vault::{hidden, real};

/// What the user has seen of one vault.
#[derive(Serialize, Deserialize)]
struct State {
    /// The vault's folder, for a person who reads the file.
    vault: String,
    /// The commit whose notes count as seen.
    base: String,
    /// Notes that were seen with another text than they have at `base`, by path.
    // shortcut: the accepted texts are all in this one file, which every operation reads and
    // writes whole; a file per note when a vault keeps so many between two "accept all" that it is slow
    accepted: BTreeMap<String, Seen>,
}

/// The text of a note that the user accepted.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Seen {
    /// Only its `digest`: what a state file written before the texts were kept has, and a
    /// note that is not UTF-8. Enough to tell that the note changed again, not to show
    /// what it was, so such a note is compared with `base`.
    Digest(String),
    /// The text. `None`: no note, an accepted deletion.
    Text { text: Option<String> },
}

impl Seen {
    /// `text` as read from disk, `None` for a note that is not there.
    fn of(text: Option<Vec<u8>>) -> Self {
        match text.map(String::from_utf8) {
            None => Seen::Text { text: None },
            Some(Ok(text)) => Seen::Text { text: Some(text) },
            Some(Err(bytes)) => Seen::Digest(digest(bytes.as_bytes())),
        }
    }

    /// Whether `now`, the note's bytes on disk, is the accepted text.
    fn is(&self, now: &[u8]) -> bool {
        match self {
            Seen::Digest(seen) => *seen == digest(now),
            Seen::Text { text } => text.as_deref().unwrap_or_default().as_bytes() == now,
        }
    }
}

/// One note that waits for review.
#[derive(Serialize, Debug)]
pub struct Entry {
    pub path: String,
    /// `changed`, `added` (not in `base`) or `deleted` (not on disk).
    pub status: &'static str,
    /// Lines the note has more and fewer than in the text the user last saw (the accepted one, else that of `base`), as git counts them.
    pub added: usize,
    pub removed: usize,
    /// The commits since `base` that changed it, newest first. Merge commits are left out.
    pub commits: Vec<Commit>,
    /// Whether its text on disk is not what the last commit has.
    pub uncommitted: bool,
}

#[derive(Serialize, Debug)]
pub struct Inbox {
    /// False when the vault is not in a git repository with a commit: review then has nothing to compare with.
    pub repository: bool,
    pub entries: Vec<Entry>,
}

/// A short name for a text, to tell whether it is still the one that was seen. Not git's
/// hash: that would take a `git` run per note.
// FNV-1a over the bytes, with the length in front. Two texts with one digest would hide
// a change; by chance that takes about 2^32 versions of one note.
pub(crate) fn digest(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3));
    format!("{}-{hash:016x}", bytes.len())
}

/// The note's bytes on disk. `None` when it is not there, or a symbolic link takes its path out of the vault.
fn read(root: &Path, path: &str) -> Option<Vec<u8>> {
    fs::read(real(root, path).ok()?).ok()
}

/// The note's bytes on disk. Empty when it is not there.
fn on_disk(root: &Path, path: &str) -> Vec<u8> {
    read(root, path).unwrap_or_default()
}

/// Whether review is about this file: a note, outside the dot folders.
fn is_note(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".md") && !hidden(path)
}

/// The commit the branch is on. `None` without a repository, a commit, or `git`.
fn head(root: &Path) -> Option<String> {
    let out = git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?;
    Some(String::from_utf8(out).ok()?.trim().to_string())
}

/// A note of the vault whose text differs between a commit and the disk.
struct Change {
    /// Whether the commit has no such note.
    new: bool,
    added: usize,
    removed: usize,
}

/// The notes the commit `rev` has in the vault's folder, by path, each with the hash of its text.
fn notes_at(root: &Path, rev: &str) -> BTreeMap<String, String> {
    // Without `--full-tree` the names are as seen from the vault's folder, which need not be the repository's root.
    let out = git(root, &["ls-tree", "-r", "-z", rev]).unwrap_or_default();
    let text = String::from_utf8_lossy(&out);
    // `<mode> <type> <hash>`, a tab, the path. A mode other than a file's is a link or another repository.
    let entry = |entry: &str| {
        let (meta, path) = entry.split_once('\t')?;
        let mut meta = meta.split(' ');
        let (mode, kind, hash) = (meta.next()?, meta.next()?, meta.next()?);
        (mode.starts_with("100") && kind == "blob" && is_note(path)).then(|| (path.to_string(), hash.to_string()))
    };
    text.split('\0').filter_map(entry).collect()
}

/// The notes on disk that git tracks, or does not track and is not told to ignore. Git
/// lists names for this and reads no note.
fn notes_listed(root: &Path) -> Vec<String> {
    let out = git(root, &["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."]).unwrap_or_default();
    String::from_utf8_lossy(&out).split('\0').filter(|path| is_note(path)).map(str::to_string).collect()
}

/// Every note of the vault whose text on disk differs from the commit `rev`, by path. A
/// note the commit does not have is in it when it has text.
// shortcut: reads every note of the commit from git and from disk on each call; remember
// the comparison per commit and file time if the inbox gets slow in a vault of many thousand notes
fn changes(root: &Path, rev: &str) -> BTreeMap<String, Change> {
    let at_rev = notes_at(root, rev);
    let hashes: Vec<&str> = at_rev.values().map(String::as_str).collect();
    let committed = blobs(root, &hashes).unwrap_or_default();
    // An object the repository does not have (a partial clone) counts as an empty text.
    let mut was: BTreeMap<&str, Vec<u8>> = at_rev.keys().map(String::as_str).zip(committed.into_iter().map(Option::unwrap_or_default)).collect();
    let listed = notes_listed(root);
    let paths: BTreeSet<&str> = at_rev.keys().chain(&listed).map(String::as_str).collect();
    let mut found = BTreeMap::new();
    for path in paths {
        let new = !at_rev.contains_key(path);
        let (was, now) = (was.remove(path).unwrap_or_default(), on_disk(root, path));
        if was != now {
            let (added, removed) = line_counts(&was, &now);
            found.insert(path.to_string(), Change { new, added, removed });
        }
    }
    found
}

/// The lines `now` has more and fewer than `was`, as `git diff --numstat` counts them: a
/// line is its text with its line end, so a last line that lost or got its newline is a
/// changed line.
pub(crate) fn line_counts(was: &[u8], now: &[u8]) -> (usize, usize) {
    fn lines(text: &[u8]) -> Vec<&[u8]> {
        text.split_inclusive(|byte| *byte == b'\n').collect()
    }
    let (was, now) = (lines(was), lines(now));
    // The lines both start and end with are not part of the question.
    let start = was.iter().zip(&now).take_while(|(a, b)| a == b).count();
    let (was, now) = (&was[start..], &now[start..]);
    let end = was.iter().rev().zip(now.iter().rev()).take_while(|(a, b)| a == b).count();
    let (was, now) = (&was[..was.len() - end], &now[..now.len() - end]);
    let (n, m) = (was.len(), now.len());
    // Myers' algorithm, without the path: the fewest removals and additions `d` that turn
    // `was` into `now`. `reach[k]` is how far into `was` a path of `d` steps gets on the
    // diagonal `k` (the place in `was` minus the place in `now`).
    // shortcut: gives up at 4000 changed lines and counts every line between the common
    // start and end as changed; count through a patience diff if such notes come up
    let most = (n + m).min(4000);
    let at = |k: isize| (k + most as isize + 1) as usize;
    let mut reach = vec![0usize; 2 * most + 3];
    for d in 0..=most as isize {
        for k in (-d..=d).step_by(2) {
            let mut x = if k == -d || (k != d && reach[at(k - 1)] < reach[at(k + 1)]) { reach[at(k + 1)] } else { reach[at(k - 1)] + 1 };
            let mut y = (x as isize - k) as usize;
            while x < n && y < m && was[x] == now[y] {
                (x, y) = (x + 1, y + 1);
            }
            reach[at(k)] = x;
            if x >= n && y >= m {
                let common = (n + m - d as usize) / 2;
                return (m - common, n - common);
            }
        }
    }
    (m, n)
}

/// Whether the note waits for review. `now` is its bytes on disk, `changed` whether those differ from `base`.
fn waits(state: &State, path: &str, now: &[u8], changed: bool) -> bool {
    match state.accepted.get(path) {
        Some(seen) if seen.is(now) => false,
        Some(Seen::Text { .. }) => true,
        _ => changed,
    }
}

/// Makes the text the note has on disk now the accepted one. `changed`: whether it differs from `base`.
fn accept_now(state: &mut State, root: &Path, path: &str, changed: bool) {
    if changed {
        state.accepted.insert(path.to_string(), Seen::of(read(root, path)));
    } else {
        // The text of `base` is seen as it is.
        state.accepted.remove(path);
    }
}

/// The note's bytes in the commit `rev`. `None` when the commit has no such file.
fn committed(root: &Path, rev: &str, path: &str) -> Option<Vec<u8>> {
    git(root, &["cat-file", "blob", &format!("{rev}:./{path}")])
}

fn state_file(dir: &Path, root: &Path) -> PathBuf {
    dir.join("review").join(digest(root.as_os_str().as_encoded_bytes()) + ".json")
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

/// The state in which nothing waits: `head` is seen, and so is every note that is not committed.
fn all_seen(root: &Path, head: &str) -> State {
    let accepted = changes(root, head).into_keys().map(|path| (path.clone(), Seen::of(read(root, &path)))).collect();
    State { vault: root.display().to_string(), base: head.to_string(), accepted }
}

/// The vault's state and the commit the branch is on. `None` when there is no repository to compare with.
fn open(dir: &Path, root: &Path) -> Result<Option<(State, String)>, Error> {
    let Some(head) = head(root) else { return Ok(None) };
    let kept = fs::read(state_file(dir, root)).ok().and_then(|bytes| serde_json::from_slice::<State>(&bytes).ok());
    // The hash is from our own file, but it is checked like any other before it goes to git.
    let usable = |state: &State| {
        (4..=64).contains(&state.base.len())
            && state.base.bytes().all(|b| b.is_ascii_hexdigit())
            && git(root, &["cat-file", "-e", &format!("{}^{{commit}}", state.base)]).is_some()
    };
    if let Some(state) = kept.filter(usable) {
        return Ok(Some((state, head)));
    }
    // First use in this vault: review starts from what is there now, so the inbox starts empty.
    // shortcut: a state file that is broken, or whose commit is gone from the repository (history
    // rewritten and pruned), starts over the same way and what was waiting is dropped; keep
    // each note's digest at `base` in the state if that turns out to happen
    let state = all_seen(root, &head);
    save(dir, root, &state)?;
    Ok(Some((state, head)))
}

/// The notes whose text is not the one the user last saw: the accepted one, else that of `base`.
pub fn list(dir: &Path, root: &Path) -> Result<Inbox, Error> {
    let Some((state, head)) = open(dir, root)? else { return Ok(Inbox { repository: false, entries: Vec::new() }) };
    let since_base = changes(root, &state.base);
    // What is not committed: when `base` is the last commit that is everything found, else it is asked for.
    let since_head = (state.base != head).then(|| changes(root, &head));
    let dirty = since_head.as_ref().unwrap_or(&since_base);
    let mut entries: BTreeMap<String, Entry> = BTreeMap::new();
    // An accepted note can wait with the text of `base`: when it went back to it after the accept.
    for path in since_base.keys().chain(state.accepted.keys()).filter(|path| is_note(path)) {
        let now = read(root, path);
        let text = now.as_deref().unwrap_or_default();
        let change = since_base.get(path);
        if !waits(&state, path, text, change.is_some()) {
            continue;
        }
        let (new, added, removed) = match (state.accepted.get(path), change) {
            (Some(Seen::Text { text: was }), _) => {
                let (added, removed) = line_counts(was.as_deref().unwrap_or_default().as_bytes(), text);
                (was.is_none(), added, removed)
            }
            (_, Some(change)) => (change.new, change.added, change.removed),
            // Not reached: without an accepted text a note waits only when it differs from `base`.
            (_, None) => continue,
        };
        let status = if now.is_none() { "deleted" } else if new { "added" } else { "changed" };
        let uncommitted = dirty.contains_key(path);
        entries.insert(path.clone(), Entry { path: path.clone(), status, added, removed, commits: Vec::new(), uncommitted });
    }
    if state.base != head {
        let range = format!("{}..{head}", state.base);
        let log = git(root, &["log", "-z", "--name-only", "--no-renames", "--relative", FORMAT, &range, "--", "."]);
        for (commit, names) in log.map(|out| commits(&out)).unwrap_or_default() {
            for name in names {
                if let Some(entry) = entries.get_mut(&name) {
                    entry.commits.push(commit.clone());
                }
            }
        }
    }
    Ok(Inbox { repository: true, entries: entries.into_values().collect() })
}

/// The text the note is compared with: the one the user last accepted, else the one at
/// `base`. `None` when there was no note then, or it is not text.
pub fn base(dir: &Path, root: &Path, path: &str) -> Result<Option<String>, Error> {
    let Some((state, _)) = open(dir, root)? else { return Ok(None) };
    if let Some(Seen::Text { text }) = state.accepted.get(path) {
        return Ok(text.clone());
    }
    Ok(committed(root, &state.base, path).and_then(|bytes| String::from_utf8(bytes).ok()))
}

/// Marks the text one note has on disk now as seen, or with no path everything: the
/// last commit becomes `base` and what is not committed is accepted as it is.
pub fn accept(dir: &Path, root: &Path, path: Option<&str>) -> Result<(), Error> {
    let Some((mut state, head)) = open(dir, root)? else { return Ok(()) };
    match path {
        Some(path) => {
            let changed = changes(root, &state.base).contains_key(path);
            accept_now(&mut state, root, path, changed);
        }
        None => state = all_seen(root, &head),
    }
    save(dir, root, &state)
}

/// The app wrote the user's own edit of a note: `after` in place of `before`. If `before`
/// was not waiting for review, `after` does not either. A note that was waiting stays.
pub fn saved(dir: &Path, root: &Path, path: &str, before: &str, after: &str) -> Result<(), Error> {
    let Some((mut state, _)) = open(dir, root)? else { return Ok(()) };
    // The file has `after` by now, so what `before` was to `base` is asked of the commit.
    let at_base = committed(root, &state.base, path).unwrap_or_default();
    if waits(&state, path, before.as_bytes(), before.as_bytes() != at_base) {
        return Ok(());
    }
    if after.as_bytes() == at_base {
        state.accepted.remove(path);
    } else {
        state.accepted.insert(path.to_string(), Seen::Text { text: Some(after.to_string()) });
    }
    save(dir, root, &state)
}

/// Before an operation the user does in the app (a rename, a delete, a new note): the
/// notes among `paths` that do not wait for review. `accept_own` takes them after it.
/// None without a state folder, and none in a vault where review was never used: the
/// first use is what makes the state, with everything seen.
pub fn settled<'a>(dir: Option<&Path>, root: &Path, paths: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let Some(dir) = dir.filter(|dir| state_file(dir, root).exists()) else { return Vec::new() };
    let Ok(Some((state, _))) = open(dir, root) else { return Vec::new() };
    let changed = changes(root, &state.base);
    let settled = |path: &&str| is_note(path) && !waits(&state, path, &on_disk(root, path), changed.contains_key(*path));
    paths.into_iter().filter(settled).map(str::to_string).collect()
}

/// After that operation: what the notes at `paths` are now is accepted, a note that is
/// gone as a deletion, so what the user did in the app does not wait for the user's review.
pub fn accept_own(dir: Option<&Path>, root: &Path, paths: &[String]) {
    let Some(dir) = dir.filter(|_| !paths.is_empty()) else { return };
    let Ok(Some((mut state, _))) = open(dir, root) else { return };
    let changed = changes(root, &state.base);
    for path in paths {
        accept_now(&mut state, root, path, changed.contains_key(path));
    }
    // The operation is done and is not failed for this: if the state cannot be written, the notes wait.
    let _ = save(dir, root, &state);
}

#[cfg(test)]
mod tests {
    use super::line_counts;

    /// The same answer the slow way: the longest common run of lines, by the table.
    fn slow(was: &str, now: &str) -> (usize, usize) {
        let (a, b): (Vec<&str>, Vec<&str>) = (was.split_inclusive('\n').collect(), now.split_inclusive('\n').collect());
        let mut table = vec![vec![0usize; b.len() + 1]; a.len() + 1];
        for i in 0..a.len() {
            for j in 0..b.len() {
                table[i + 1][j + 1] = if a[i] == b[j] { table[i][j] + 1 } else { table[i][j + 1].max(table[i + 1][j]) };
            }
        }
        let common = table[a.len()][b.len()];
        (b.len() - common, a.len() - common)
    }

    #[test]
    fn lines_are_counted_as_git_counts_them() {
        assert_eq!(line_counts(b"", b""), (0, 0));
        assert_eq!(line_counts(b"a\nb\n", b"a\nb\n"), (0, 0));
        assert_eq!(line_counts(b"", b"a\nb\n"), (2, 0));
        assert_eq!(line_counts(b"a\nb\n", b""), (0, 2));
        assert_eq!(line_counts(b"a\nb\nc\n", b"a\nB\nc\nd\n"), (2, 1));
        // A last line that lost its newline is a changed line.
        assert_eq!(line_counts(b"a\nb\n", b"a\nb"), (1, 1));
        assert_eq!(line_counts(b"x\r\n", b"x\n"), (1, 1));
        // Not text: counted by its newlines all the same.
        assert_eq!(line_counts(&[0, 159, b'\n'], &[0, 159, b'\n', 7]), (1, 0));

        // Every pair of short texts over three lines, against the table.
        let lines = ["a\n", "b\n", "c\n"];
        let mut texts = vec![String::new()];
        for length in 1..=5 {
            for n in 0..3usize.pow(length) {
                texts.push((0..length).map(|at| lines[n / 3usize.pow(at) % 3]).collect());
            }
        }
        for was in texts.iter().step_by(7) {
            for now in texts.iter().step_by(5) {
                assert_eq!(line_counts(was.as_bytes(), now.as_bytes()), slow(was, now), "{was:?} to {now:?}");
            }
        }
    }

    #[test]
    fn a_text_with_more_changed_lines_than_the_limit_counts_all_of_them() {
        let was: String = (0..5000).map(|n| format!("old {n}\n")).collect();
        let now: String = (0..5000).map(|n| format!("new {n}\n")).collect();
        assert_eq!(line_counts(format!("top\n{was}end\n").as_bytes(), format!("top\n{now}end\n").as_bytes()), (5000, 5000));
    }
}
