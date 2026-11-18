//! The in-memory note index: wikilink parsing and resolution, backlinks,
//! search, and the link rewriting behind a rename.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::Range;

use serde::Serialize;

use crate::{Entry, Error, Vault};

/// Every `.md` note in the vault with its text, sorted by path.
// shortcut: a full rescan that keeps every note's text in memory, fine for a
// few thousand notes; make it an incremental or on-disk index when vaults get large.
pub struct Index {
    notes: Vec<Note>,
    /// The other files (images and so on): lowercased path to path. Only a move
    /// looks at them, to keep the embeds of a file that moves working.
    files: HashMap<String, String>,
    /// For each file name, lowercased and without `.md`: where its notes are in `notes`,
    /// in that order. A link is resolved among the notes of its name instead of all notes.
    names: HashMap<String, Vec<usize>>,
}

struct Note {
    path: String,
    /// The path lowercased and without `.md`, which is what links are matched against.
    key: String,
    content: String,
}

/// One result line of `note.backlinks` and `search`.
#[derive(Debug, Serialize, PartialEq)]
pub struct Hit {
    pub path: String,
    /// 1-based. 0 means the file name matched, not a line.
    pub line: usize,
    pub text: String,
}

/// The result of `vault.graph`.
#[derive(Debug, Serialize, PartialEq)]
pub struct Graph {
    /// Every note, sorted by path.
    pub nodes: Vec<Node>,
    /// Sorted by `from`, then `to`. A pair of notes that link to each other has two.
    pub edges: Vec<Edge>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Node {
    pub path: String,
    /// How many edges start or end at this note.
    pub links: usize,
}

/// A link from the note at `from` to the note at `to`.
#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct Edge {
    pub from: String,
    pub to: String,
}

/// A note with links that reach nothing, in `vault.health`.
#[derive(Debug, Serialize, PartialEq)]
pub struct Broken {
    pub path: String,
    pub links: Vec<BrokenLink>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct BrokenLink {
    /// 1-based.
    pub line: usize,
    /// The text between the brackets, as written.
    pub link: String,
    /// The line the link is on.
    pub text: String,
}

/// A note with open checkboxes, in `vault.tasks`.
#[derive(Debug, Serialize, PartialEq)]
pub struct NoteTasks {
    pub path: String,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Task {
    /// 1-based.
    pub line: usize,
    /// The text after the checkbox.
    pub text: String,
}

/// One `[[...]]` or `![[...]]` found in a note.
struct Link<'a> {
    /// 1-based line number.
    line: usize,
    /// The whole line the link is on.
    text: &'a str,
    /// Byte range of the text between the brackets.
    inner: Range<usize>,
}

impl Index {
    pub fn build(vault: &Vault) -> Result<Self, Error> {
        let (mut paths, mut files) = (Vec::new(), HashMap::new());
        file_paths(&vault.tree()?, &mut paths, &mut files);
        paths.sort();
        let notes = paths
            .into_iter()
            // A note that cannot be read as UTF-8 text is left out instead of failing every query.
            .filter_map(|path| {
                let content = vault.read(&path).ok()?;
                Some(Note { key: key(&path), path, content })
            })
            .collect();
        Ok(Self::new(notes, files))
    }

    fn new(notes: Vec<Note>, files: HashMap<String, String>) -> Self {
        let mut names: HashMap<String, Vec<usize>> = HashMap::new();
        for (at, note) in notes.iter().enumerate() {
            names.entry(file_name(&note.key).to_string()).or_default().push(at);
        }
        Self { notes, files, names }
    }

    /// The note a link points to. `link` is the text inside the brackets and
    /// `from` the path of the note containing it.
    pub fn resolve(&self, link: &str, from: &str) -> Option<&str> {
        let target = normalize(link);
        if target.is_empty() {
            // `[[#heading]]` points into the note itself.
            return self.notes.iter().find(|n| n.path == from).map(|n| n.path.as_str());
        }
        // A bare name matches any note with that file name; a path matches the
        // whole path or its end. Both are "the key is the target or ends with /target".
        // A leading slash makes even a single name a path, so `[[/Note]]` is the note
        // at the vault root when there is one, whatever is next to the linking note.
        let by_path = target.contains('/') || link.trim_start().starts_with('/');
        let suffix = format!("/{target}");
        // The file name as the link writes it, capitals included. Names match in any case, but
        // between two notes that differ only in case the one written exactly wins, before
        // nearness: a vault can hold `Tasks/Inklode.md` and `Projects/inklode.md`.
        let written = self::target(link).trim();
        let written = written.rsplit('/').next().unwrap_or(written);
        let written = written.strip_suffix(".md").unwrap_or(written);
        let name = |path: &str| {
            let file = path.rsplit('/').next().unwrap_or(path);
            file.strip_suffix(".md").unwrap_or(file).to_string()
        };
        // Every key that is the target or ends with `/target` has the target's file name,
        // so the notes of that name are all the candidates there are.
        let named = self.names.get(file_name(&target)).map_or(&[][..], Vec::as_slice);
        named
            .iter()
            .map(|at| &self.notes[*at])
            .filter(|n| n.key == target || n.key.ends_with(&suffix))
            .min_by_key(|n| {
                (
                    by_path && n.key != target,
                    name(&n.path) != written,
                    folder(&n.path) != folder(from),
                    n.path.len(),
                    &n.path,
                )
            })
            .map(|n| n.path.as_str())
    }

    /// Lines in other notes that link to `path`, sorted by path then line.
    pub fn backlinks(&self, path: &str) -> Vec<Hit> {
        let mut hits: Vec<Hit> = Vec::new();
        for note in self.notes.iter().filter(|n| n.path != path) {
            for link in links(&note.content) {
                let twice_on_line = hits.last().is_some_and(|h| h.path == note.path && h.line == link.line);
                if !twice_on_line && self.points_to(&note.content[link.inner.clone()], &note.path, path) {
                    hits.push(hit(&note.path, link.line, link.text));
                }
            }
        }
        hits
    }

    /// Case-insensitive substring search over file names, then note lines.
    // shortcut: scans every line of every note per query and returns at most
    // 200 hits, fine for a few thousand notes; use a real search index beyond that.
    pub fn search(&self, query: &str) -> Vec<Hit> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Vec::new();
        }
        let names = self
            .notes
            .iter()
            .filter(|n| n.key.rsplit('/').next().unwrap_or_default().contains(&query))
            .map(|n| hit(&n.path, 0, ""));
        let lines = self.notes.iter().flat_map(|n| {
            let query = &query;
            n.content
                .lines()
                .enumerate()
                .filter(move |(_, line)| line.to_lowercase().contains(query))
                .map(|(i, line)| hit(&n.path, i + 1, line))
        });
        names.chain(lines).take(200).collect()
    }

    /// The paths of the notes, sorted.
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.notes.iter().map(|note| note.path.as_str())
    }

    /// Paths of the notes whose links a move of `from` to `to` can change: the
    /// notes that move, and the notes with a link ending in a name that something
    /// that moves has before or after. The name after counts because a link that
    /// already uses it can now reach the file that arrived instead of the one it
    /// meant. No other link can resolve differently afterwards.
    pub fn affected(&self, from: &str, to: &str) -> Vec<&str> {
        let moves = |path: &str| relocate(path, from, "") != path;
        let name = |key: &str| key.rsplit('/').next().unwrap_or_default().to_string();
        let moved = self.notes.iter().map(|n| &n.path).chain(self.files.values()).filter(|path| moves(path));
        let names: HashSet<String> = moved.flat_map(|path| [name(&key(path)), name(&key(&relocate(path, from, to)))]).collect();
        self.notes
            .iter()
            .filter(|n| moves(&n.path) || links(&n.content).iter().any(|l| names.contains(&name(&normalize(&n.content[l.inner.clone()])))))
            .map(|n| n.path.as_str())
            .collect()
    }

    /// This index after `from` became `to`, for resolving links only: the
    /// notes have their new paths and no text.
    pub fn relocated(&self, from: &str, to: &str) -> Index {
        let notes = self.notes.iter().map(|n| {
            let path = relocate(&n.path, from, to);
            Note { key: key(&path), path, content: String::new() }
        });
        let files = self.files.values().map(|path| relocate(path, from, to)).map(|path| (path.to_lowercase(), path));
        Index::new(notes.collect(), files.collect())
    }

    /// `content`, the text of the note that was at `note` before `from` (a
    /// file, or a folder with everything in it) became `to`, with its links
    /// pointing where they pointed before. `after` is `self.relocated(from, to)`.
    /// `None` when nothing has to change: a link that still reaches the same
    /// file from where the note is now is left exactly as written, so a move
    /// that keeps the name leaves bare-name links alone.
    ///
    /// Only the target of a link is replaced, so `#heading`, `|alias` and the
    /// `!` of embeds stay. A link written as a bare name gets the new bare name
    /// when that reaches the file, and the path from the vault root otherwise; a
    /// link written as a path gets the new path. Notes are written without `.md`.
    /// Fails with `LinkLost` when neither form reaches the file: a note at the
    /// root with the name of a note next to the linking one. `[[/Name]]` would
    /// say it here, but Obsidian does not read that form (checked 2026-11-16).
    // shortcut: Markdown links `[text](path.md)` and image paths with `../` are
    // not rewritten; handle these when rename has to be safe in vaults with mixed
    // link styles.
    pub fn rewrite_links(&self, after: &Index, note: &str, content: &str, from: &str, to: &str) -> Result<Option<String>, Error> {
        let note_after = relocate(note, from, to);
        let mut out = String::new();
        let mut done = 0;
        for link in links(content) {
            let inner = &content[link.inner.clone()];
            let Some(before) = self.file_of(inner, note) else { continue };
            let wanted = relocate(before, from, to);
            if after.file_of(inner, &note_after) == Some(wanted.as_str()) {
                continue;
            }
            let old = target(inner);
            let path = wanted.strip_suffix(".md").unwrap_or(&wanted);
            let name = path.rsplit('/').next().unwrap_or(path);
            let reaches = |link: &str| after.file_of(link, &note_after) == Some(wanted.as_str());
            let new = if !old.contains('/') && reaches(name) {
                name.to_string()
            } else if reaches(path) {
                path.to_string()
            } else {
                return Err(Error::LinkLost(note.to_string(), path.to_string()));
            };
            // Nothing better to write than what is there: the note is not touched for it.
            if new == old {
                continue;
            }
            out.push_str(&content[done..link.inner.start]);
            out.push_str(&new);
            done = link.inner.start + old.len();
        }
        if done == 0 {
            return Ok(None);
        }
        out.push_str(&content[done..]);
        Ok(Some(out))
    }

    /// The text of the note at `path` as the index read it, empty when there is none.
    pub fn content(&self, path: &str) -> &str {
        self.notes.iter().find(|n| n.path == path).map_or("", |n| n.content.as_str())
    }

    /// The note a link points to, or else the file it embeds. A file is looked
    /// for where the editor looks for an image: next to the note, then from the
    /// vault root (a leading slash is the root only).
    fn file_of(&self, link: &str, from: &str) -> Option<&str> {
        self.resolve(link, from).or_else(|| {
            let target = target(link).trim().to_lowercase();
            let beside = format!("{}/{target}", folder(from).to_lowercase());
            let found = self.files.get(&beside).or_else(|| self.files.get(target.trim_start_matches('/')));
            found.map(String::as_str)
        })
    }

    /// The notes and the links between them, for the graph view. Every note is a
    /// node. A link that resolves to another note is an edge; links that repeat,
    /// point nowhere or point into their own note are left out.
    pub fn graph(&self) -> Graph {
        let mut edges = BTreeSet::new();
        for note in &self.notes {
            for link in links(&note.content) {
                match self.resolve(&note.content[link.inner], &note.path) {
                    Some(to) if to != note.path => edges.insert(Edge { from: note.path.clone(), to: to.to_string() }),
                    _ => false,
                };
            }
        }
        let mut links_of: HashMap<&str, usize> = HashMap::new();
        for end in edges.iter().flat_map(|e| [&e.from, &e.to]) {
            *links_of.entry(end).or_default() += 1;
        }
        let nodes = self
            .notes
            .iter()
            .map(|n| Node { path: n.path.clone(), links: links_of.get(n.path.as_str()).copied().unwrap_or(0) })
            .collect();
        Graph { nodes, edges: edges.into_iter().collect() }
    }

    /// For each note, in the order of `paths`: the positions in that order of the other
    /// notes its links and embeds reach, sorted and each once. What `graph` gives as
    /// edges, as lists to walk.
    pub fn adjacency(&self) -> Vec<Vec<usize>> {
        let at: HashMap<&str, usize> = self.notes.iter().enumerate().map(|(at, note)| (note.path.as_str(), at)).collect();
        let reached = |note: &Note| {
            let mut to: Vec<usize> = links(&note.content)
                .into_iter()
                .map(|link| &note.content[link.inner])
                // `[[#heading]]` stays in its note, and `resolve` would look through all notes for it.
                .filter(|link| !normalize(link).is_empty())
                .filter_map(|link| self.resolve(link, &note.path))
                .map(|path| at[path])
                .filter(|to| *to != at[note.path.as_str()])
                .collect();
            to.sort_unstable();
            to.dedup();
            to
        };
        self.notes.iter().map(reached).collect()
    }

    /// The targets of the links and embeds in the note at `path` that reach no note and
    /// no file, as written (without `#heading` and `|alias`), in the order they first
    /// appear. A target written again, in any case, is listed once.
    pub fn unresolved(&self, path: &str) -> Vec<String> {
        let content = self.content(path);
        let mut lost: Vec<String> = Vec::new();
        for link in links(content) {
            let inner = &content[link.inner];
            let name = target(inner).trim();
            if self.file_of(inner, path).is_none() && !lost.iter().any(|seen| seen.to_lowercase() == name.to_lowercase()) {
                lost.push(name.to_string());
            }
        }
        lost
    }

    /// The links and embeds that reach no note and no file, grouped by the note they
    /// are in, by path then line. `[[#heading]]` and `[[Note#heading]]` count as reaching
    /// their note.
    // shortcut: a link to a heading or block that its note does not have is not
    // reported; read the headings here when such links should count as broken.
    pub fn broken(&self) -> Vec<Broken> {
        let of = |note: &Note| {
            let lost = links(&note.content).into_iter().filter(|link| self.file_of(&note.content[link.inner.clone()], &note.path).is_none());
            let links: Vec<BrokenLink> = lost
                .map(|link| BrokenLink { line: link.line, link: note.content[link.inner].to_string(), text: clip(link.text) })
                .collect();
            (!links.is_empty()).then(|| Broken { path: note.path.clone(), links })
        };
        self.notes.iter().filter_map(of).collect()
    }

    /// The open checkboxes (`- [ ]`) outside fenced code blocks, grouped by note, by
    /// path then line. Notes without one are left out.
    pub fn tasks(&self) -> Vec<NoteTasks> {
        let of = |note: &Note| {
            let tasks: Vec<Task> = unfenced(&note.content)
                .filter_map(|(line, _, text)| Some(Task { line, text: clip(open_task(text)?) }))
                .collect();
            (!tasks.is_empty()).then(|| NoteTasks { path: note.path.clone(), tasks })
        };
        self.notes.iter().filter_map(of).collect()
    }

    /// Every note as `(path, text)`, sorted by path.
    pub fn texts(&self) -> impl Iterator<Item = (&str, &str)> {
        self.notes.iter().map(|note| (note.path.as_str(), note.content.as_str()))
    }

    fn points_to(&self, link: &str, from: &str, path: &str) -> bool {
        // Cheap check first: a link can only reach `path` if it ends with its
        // file name. This keeps a backlinks query from resolving every link in the vault.
        let name = key(path);
        let name = name.rsplit('/').next().unwrap_or_default();
        normalize(link).ends_with(name) && self.resolve(link, from) == Some(path)
    }
}

#[cfg(test)]
impl Index {
    /// An index of these files, for tests. A path that does not end in `.md` is a file that is not a note.
    pub(crate) fn of(notes: &[(&str, &str)]) -> Index {
        let (notes, files): (Vec<_>, Vec<_>) = notes.iter().partition(|(path, _)| path.ends_with(".md"));
        let mut notes: Vec<Note> = notes
            .iter()
            .map(|(path, content)| Note { path: path.to_string(), key: key(path), content: content.to_string() })
            .collect();
        notes.sort_by(|a, b| a.path.cmp(&b.path));
        Index::new(notes, files.iter().map(|(path, _)| (path.to_lowercase(), path.to_string())).collect())
    }
}

/// The target part of a link: the text before `|alias` and `#heading`.
/// Always a prefix of `link`. In a table the alias bar is written `\|`.
fn target(link: &str) -> &str {
    let target = link.split('|').next().unwrap_or(link);
    let target = target.strip_suffix('\\').unwrap_or(target);
    target.split('#').next().unwrap_or(target)
}

/// The target in the form note keys have: lowercase, no `.md`, no leading slash.
fn normalize(link: &str) -> String {
    key(target(link).trim().trim_start_matches('/'))
}

fn key(path: &str) -> String {
    let lower = path.to_lowercase();
    lower.strip_suffix(".md").unwrap_or(&lower).to_string()
}

/// Where `path` is after `from` (a file, or a folder with everything in it) became `to`.
pub fn relocate(path: &str, from: &str, to: &str) -> String {
    match path.strip_prefix(from) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{to}{rest}"),
        _ => path.to_string(),
    }
}

/// The last part of a path or key.
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn folder(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

fn hit(path: &str, line: usize, text: &str) -> Hit {
    Hit { path: path.to_string(), line, text: clip(text) }
}

/// A line as the lists show it: without the space around it, 200 characters at most.
pub(crate) fn clip(text: &str) -> String {
    text.trim().chars().take(200).collect()
}

fn file_paths(entries: &[Entry], notes: &mut Vec<String>, files: &mut HashMap<String, String>) {
    for entry in entries {
        match &entry.children {
            Some(children) => file_paths(children, notes, files),
            None if entry.path.to_lowercase().ends_with(".md") => notes.push(entry.path.clone()),
            None => drop(files.insert(entry.path.to_lowercase(), entry.path.clone())),
        }
    }
}

/// The lines of a note that are not in a fenced code block, nor a fence line: each with
/// its 1-based number and the byte offset it starts at, and still ending in its newline.
// shortcut: any line starting with ``` or ~~~ toggles a fence, so a fence
// nested in a longer fence ends it early; use a Markdown parser if that shows up.
pub(crate) fn unfenced(content: &str) -> impl Iterator<Item = (usize, usize, &str)> {
    let mut in_fence = false;
    let mut line_start = 0;
    content.split_inclusive('\n').enumerate().filter_map(move |(i, line)| {
        let start = line_start;
        line_start += line.len();
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            return None;
        }
        (!in_fence).then_some((i + 1, start, line))
    })
}

/// Finds the wikilinks in a note, skipping fenced code blocks and inline code.
fn links(content: &str) -> Vec<Link<'_>> {
    let mut out = Vec::new();
    for (number, start, line) in unfenced(content) {
        let bytes = line.as_bytes();
        let mut at = 0;
        while at < bytes.len() {
            if bytes[at] == b'`' {
                // Inline code runs to the next run of as many backticks.
                let ticks = bytes[at..].iter().take_while(|b| **b == b'`').count();
                at += ticks;
                if let Some(close) = line[at..].find(&"`".repeat(ticks)) {
                    at += close + ticks;
                }
            } else if bytes[at..].starts_with(b"[[") {
                at += 2;
                if let Some(len) = line[at..].find("]]").filter(|len| *len > 0) {
                    out.push(Link { line: number, text: line, inner: start + at..start + at + len });
                    at += len + 2;
                }
            } else {
                at += 1;
            }
        }
    }
    out
}

/// The text of an open checkbox line: `- [ ] text`, with `*`, `+`, `1.` or `1)` as the
/// list marker too, indented or not. `None` for any other line, a ticked one included.
fn open_task(line: &str) -> Option<&str> {
    let item = line.trim_start();
    let digits = item.bytes().take_while(u8::is_ascii_digit).count();
    let rest = match item.as_bytes().get(digits)? {
        b'-' | b'*' | b'+' if digits == 0 => &item[1..],
        b'.' | b')' if digits > 0 => &item[digits + 1..],
        _ => return None,
    };
    let text = rest.strip_prefix([' ', '\t'])?.trim_start().strip_prefix("[ ]")?;
    (text.is_empty() || text.starts_with(char::is_whitespace)).then(|| text.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(notes: &[(&str, &str)]) -> Index {
        Index::of(notes)
    }

    /// The notes whose text a move changes, with the new text, by the path they had before.
    #[test]
    fn between_names_that_differ_in_case_the_one_written_exactly_wins() {
        let dir = tempfile::tempdir().unwrap();
        // One folder per note: a case-insensitive disk cannot hold both names in one folder.
        for path in ["Tasks/Inklode.md", "Projects/inklode.md", "Home.md"] {
            std::fs::create_dir_all(dir.path().join(path).parent().unwrap()).unwrap();
            std::fs::write(dir.path().join(path), "").unwrap();
        }
        let idx = Index::build(&Vault::open(dir.path()).unwrap()).unwrap();
        assert_eq!(idx.resolve("Inklode", "Home.md"), Some("Tasks/Inklode.md"));
        assert_eq!(idx.resolve("inklode", "Home.md"), Some("Projects/inklode.md"));
        assert_eq!(idx.resolve("inklode#How|the app", "Home.md"), Some("Projects/inklode.md"));
        // Exact case beats the note next to the linking one.
        assert_eq!(idx.resolve("inklode", "Tasks/Other.md"), Some("Projects/inklode.md"));
        // A case no note has: the old order, shortest path first.
        assert_eq!(idx.resolve("INKLODE", "Home.md"), Some("Tasks/Inklode.md"));
    }

    fn moved(idx: &Index, from: &str, to: &str) -> Vec<(String, String)> {
        let after = idx.relocated(from, to);
        let text = |path: &str| idx.notes.iter().find(|n| n.path == path).unwrap().content.as_str();
        idx.affected(from, to)
            .into_iter()
            .filter_map(|note| Some((note.to_string(), idx.rewrite_links(&after, note, text(note), from, to).unwrap()?)))
            .collect()
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    fn inners(content: &str) -> Vec<&str> {
        links(content).into_iter().map(|l| &content[l.inner]).collect()
    }

    #[test]
    fn parses_all_link_forms_and_skips_code() {
        let text = "a [[one]] b [[two|Alias]]\n[[three#Head]] ![[four#Head|Alias]]\n`[[inline]]` ``[[double ` tick]]`` [[five]]\n```rust\n[[fenced]]\n```\n~~~\n[[tilde]]\n~~~\nünï [[six]] [[]] [[open\n";
        assert_eq!(inners(text), ["one", "two|Alias", "three#Head", "four#Head|Alias", "five", "six"]);
        let found = links(text);
        assert_eq!(found[2].line, 2);
        assert_eq!(found[5].line, 10);
        assert_eq!(target("four#Head|Alias"), "four");
        assert_eq!(target("cell\\|Alias"), "cell");
    }

    #[test]
    fn resolves_like_obsidian() {
        let idx = index(&[
            ("Home.md", ""),
            ("a/Note.md", ""),
            ("b/Note.md", ""),
            ("b/deep/Note.md", ""),
            ("b/Other.md", ""),
        ]);
        // Bare name, any case, with heading and alias, with or without `.md`.
        assert_eq!(idx.resolve("home", "a/Note.md"), Some("Home.md"));
        assert_eq!(idx.resolve("HOME.md#Top|Start", "a/Note.md"), Some("Home.md"));
        // Same folder first, else the shortest path.
        assert_eq!(idx.resolve("Note", "b/Other.md"), Some("b/Note.md"));
        assert_eq!(idx.resolve("Note", "b/deep/x.md"), Some("b/deep/Note.md"));
        assert_eq!(idx.resolve("Note", "Home.md"), Some("a/Note.md"));
        // Paths: exact, case-insensitive, and by suffix.
        assert_eq!(idx.resolve("B/note", "Home.md"), Some("b/Note.md"));
        assert_eq!(idx.resolve("deep/Note", "Home.md"), Some("b/deep/Note.md"));
        assert_eq!(idx.resolve("eep/Note", "Home.md"), None);
        assert_eq!(idx.resolve("Missing", "Home.md"), None);
        assert_eq!(idx.resolve("#Top", "Home.md"), Some("Home.md"));
    }

    #[test]
    fn backlinks_are_sorted_and_skip_self_links() {
        let idx = index(&[
            ("Home.md", "[[Home]] self\n"),
            ("b.md", "x\n  see [[Home]] and [[home|again]]  \n![[Home#Top]]\n"),
            ("a.md", "`[[Home]]`\n[[Other]]\n[[Home]]\n"),
            ("Other.md", ""),
        ]);
        assert_eq!(
            idx.backlinks("Home.md"),
            [
                hit("a.md", 3, "[[Home]]"),
                hit("b.md", 2, "see [[Home]] and [[home|again]]"),
                hit("b.md", 3, "![[Home#Top]]"),
            ]
        );
        let long = index(&[("Home.md", ""), ("a.md", &format!("[[Home]]{}", "x".repeat(500)))]);
        assert_eq!(long.backlinks("Home.md")[0].text.chars().count(), 200);
    }

    #[test]
    fn graph_has_every_note_and_one_edge_per_resolved_link() {
        let idx = index(&[
            ("Home.md", "[[a]] [[A|again]] [[Home]] [[#Top]] [[Missing]] `[[Lone]]`\n"),
            ("sub/a.md", "back [[Home]], embed ![[b]]\n"),
            ("sub/b.md", ""),
            ("Lone.md", ""),
        ]);
        let graph = idx.graph();
        let nodes: Vec<_> = graph.nodes.iter().map(|n| (n.path.as_str(), n.links)).collect();
        assert_eq!(nodes, [("Home.md", 2), ("Lone.md", 0), ("sub/a.md", 3), ("sub/b.md", 1)]);
        let edges: Vec<_> = graph.edges.iter().map(|e| (e.from.as_str(), e.to.as_str())).collect();
        assert_eq!(edges, [("Home.md", "sub/a.md"), ("sub/a.md", "Home.md"), ("sub/a.md", "sub/b.md")]);
    }

    #[test]
    fn search_puts_names_first_and_caps_results() {
        let idx = index(&[
            ("a.md", "Find the Needle here\nnothing\n"),
            ("sub/needle notes.md", "also a NEEDLE\n"),
            ("many.md", &"needle\n".repeat(300)),
        ]);
        let hits = idx.search(" Needle ");
        assert_eq!(hits[0], hit("sub/needle notes.md", 0, ""));
        assert_eq!(hits[1], hit("a.md", 1, "Find the Needle here"));
        assert_eq!(hits[2], hit("many.md", 1, "needle"));
        assert_eq!(hits.len(), 200);
        // The extension is not part of the name, so "md" does not match every note.
        assert!(idx.search("md").is_empty());
        assert!(idx.search("").is_empty());
        assert!(idx.search("  \t").is_empty());
    }

    #[test]
    fn rewrite_keeps_heading_alias_embed_and_link_style() {
        let idx = index(&[("old/Note.md", ""), ("Other.md", ""), ("a.md", "")]);
        let text = "[[Note]] [[note#Head|Alias]] ![[old/Note#Head]] [[old/Note.md|x]] [[Other]] `[[Note]]`\n";
        let after = idx.relocated("old/Note.md", "new/Renamed.md");
        assert_eq!(
            idx.rewrite_links(&after, "a.md", text, "old/Note.md", "new/Renamed.md").unwrap().unwrap(),
            "[[Renamed]] [[Renamed#Head|Alias]] ![[new/Renamed#Head]] [[new/Renamed|x]] [[Other]] `[[Note]]`\n"
        );
        assert_eq!(idx.rewrite_links(&after, "a.md", "[[Other]] text", "old/Note.md", "new/Renamed.md").unwrap(), None);
    }

    #[test]
    fn a_move_that_keeps_the_name_rewrites_only_links_that_would_break() {
        let idx = index(&[
            ("Home.md", "bare [[Note]] [[note#H|x]], full [[a/Note]], tail [[deep/Other]] [[a/deep/Other]]\n"),
            ("a/Note.md", "self [[Note]] [[#Top]], sibling [[Other]]\n"),
            ("a/deep/Other.md", "up [[Note]] [[a/Note]]\n"),
            ("Unrelated.md", "[[Home]] and [[Missing]]\n"),
        ]);
        // One note out of its folder: bare names still find it, the path does not.
        assert_eq!(
            moved(&idx, "a/Note.md", "b/Note.md"),
            pairs(&[
                ("Home.md", "bare [[Note]] [[note#H|x]], full [[b/Note]], tail [[deep/Other]] [[a/deep/Other]]\n"),
                ("a/deep/Other.md", "up [[Note]] [[b/Note]]\n"),
            ])
        );
        // The folder: the links between the notes inside it need nothing, and neither
        // does a path that still matches by its end.
        assert_eq!(
            moved(&idx, "a", "z/a2"),
            pairs(&[
                ("Home.md", "bare [[Note]] [[note#H|x]], full [[z/a2/Note]], tail [[deep/Other]] [[z/a2/deep/Other]]\n"),
                ("a/deep/Other.md", "up [[Note]] [[z/a2/Note]]\n"),
            ])
        );
        assert_eq!(idx.affected("a", "z/a2"), ["Home.md", "a/Note.md", "a/deep/Other.md"]);
        assert_eq!(relocate("a/deep/Other.md", "a", "z/a2"), "z/a2/deep/Other.md");
        assert_eq!(relocate("ab/x.md", "a", "z"), "ab/x.md");
    }

    #[test]
    fn a_move_keeps_links_on_the_note_they_meant_when_names_repeat() {
        let idx = index(&[
            ("Home.md", "[[Note]]\n"),
            ("a/Note.md", ""),
            ("a/Linker.md", "[[Note]]\n"),
            ("b/x/Note.md", ""),
            ("b/x/Friend.md", "[[Note]]\n"),
        ]);
        // `a/Note` goes somewhere as short: the shortest path wins, which is still the moved note.
        assert_eq!(moved(&idx, "a/Note.md", "c/Note.md"), []);
        // Deeper than the other note of that name, the bare name would mean that one, so it becomes a path.
        assert_eq!(
            moved(&idx, "a/Note.md", "c/deeper/Note.md"),
            pairs(&[("Home.md", "[[c/deeper/Note]]\n"), ("a/Linker.md", "[[c/deeper/Note]]\n")])
        );
        // A note that moves away from the neighbour it linked to by bare name.
        assert_eq!(moved(&idx, "b/x/Friend.md", "a/Friend.md"), pairs(&[("b/x/Friend.md", "[[b/x/Note]]\n")]));
        // A note of the same name arrives where it wins: links that meant the other note say so.
        assert_eq!(moved(&idx, "b/x/Note.md", "Note.md"), pairs(&[("Home.md", "[[a/Note]]\n")]));
        // A rename to a name that is taken elsewhere: the bare link gets the path.
        let idx = index(&[("Old.md", ""), ("a/New.md", ""), ("a/Linker.md", "[[Old]]\n"), ("Home.md", "[[Old]]\n")]);
        assert_eq!(
            moved(&idx, "Old.md", "b/New.md"),
            pairs(&[("Home.md", "[[b/New]]\n"), ("a/Linker.md", "[[b/New]]\n")])
        );
    }

    #[test]
    fn drawings_and_images_keep_their_embeds_when_they_or_the_note_move() {
        let idx = index(&[
            ("Home.md", "![[sketch.excalidraw]] ![[Art/sketch.excalidraw|300]] ![[Art/pic.png]] ![[logo.svg]] [[nope.png]]\n"),
            ("Art/sketch.excalidraw.md", "drawing"),
            ("Art/Note.md", "![[pic.png|200]] ![[Art/pic.png]] ![[/logo.svg]]\n"),
            ("Art/pic.png", ""),
            ("logo.svg", ""),
        ]);
        // A drawing is a note: its bare-name embed is found anywhere, the path is rewritten.
        assert_eq!(
            moved(&idx, "Art/sketch.excalidraw.md", "Old/sketch.excalidraw.md"),
            pairs(&[("Home.md", "![[sketch.excalidraw]] ![[Old/sketch.excalidraw|300]] ![[Art/pic.png]] ![[logo.svg]] [[nope.png]]\n")])
        );
        assert_eq!(
            moved(&idx, "Art/sketch.excalidraw.md", "Art/plan.excalidraw.md"),
            pairs(&[("Home.md", "![[plan.excalidraw]] ![[Art/plan.excalidraw|300]] ![[Art/pic.png]] ![[logo.svg]] [[nope.png]]\n")])
        );
        // An image is found next to the note or by its path from the root, so one that leaves the note's folder needs its path.
        assert_eq!(
            moved(&idx, "Art/pic.png", "img/pic.png"),
            pairs(&[
                ("Art/Note.md", "![[img/pic.png|200]] ![[img/pic.png]] ![[/logo.svg]]\n"),
                ("Home.md", "![[sketch.excalidraw]] ![[Art/sketch.excalidraw|300]] ![[img/pic.png]] ![[logo.svg]] [[nope.png]]\n"),
            ])
        );
        // The note leaves its image behind.
        assert_eq!(moved(&idx, "Art/Note.md", "Note.md"), pairs(&[("Art/Note.md", "![[Art/pic.png|200]] ![[Art/pic.png]] ![[/logo.svg]]\n")]));
        // The folder moves with both: the image next to the note needs nothing.
        assert_eq!(
            moved(&idx, "Art", "Deep/Art"),
            pairs(&[
                ("Art/Note.md", "![[pic.png|200]] ![[Deep/Art/pic.png]] ![[/logo.svg]]\n"),
                // A note's path still matches by its end. A file's path is from the root.
                ("Home.md", "![[sketch.excalidraw]] ![[Art/sketch.excalidraw|300]] ![[Deep/Art/pic.png]] ![[logo.svg]] [[nope.png]]\n"),
            ])
        );
        // An image at the root that moves is no longer found by its bare name.
        assert_eq!(
            moved(&idx, "logo.svg", "img/logo.svg"),
            pairs(&[
                ("Art/Note.md", "![[pic.png|200]] ![[Art/pic.png]] ![[img/logo.svg]]\n"),
                ("Home.md", "![[sketch.excalidraw]] ![[Art/sketch.excalidraw|300]] ![[Art/pic.png]] ![[img/logo.svg]] [[nope.png]]\n"),
            ])
        );
    }
}
