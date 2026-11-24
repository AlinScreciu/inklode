use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::index::{Index, relocate};
use crate::vault::{Write, hidden};
use crate::watch::{Listener, Watcher, watch};
use crate::{Error, Vault, claims, git, graph, health, rank, review};

/// The state behind the app: at most one open vault, its note index, and the
/// watcher that reports changes made on disk.
#[derive(Default)]
pub struct Core {
    vault: Option<Vault>,
    index: Option<Index>,
    /// Set when the vault changed since the index was built.
    dirty: Arc<AtomicBool>,
    watcher: Option<Watcher>,
    listener: Listener,
    /// Where the `review.*` operations keep what the user has seen and the `claims.*`
    /// operations the results of their checks, outside every vault.
    state_dir: Option<PathBuf>,
    /// The commits `vault.health` read from the repositories the notes name, kept between reports.
    health_logs: health::Cache,
}

/// What one `claims.check` needs of the core, taken out of it by [`Core::claim_check`], so
/// that a host can run the check without holding the core: a command may take two minutes.
pub struct ClaimCheck {
    dir: PathBuf,
    vault: Vault,
}

impl ClaimCheck {
    /// The folder of the vault the check is for, as `vault.open` gave it.
    pub fn root(&self) -> &Path {
        self.vault.root()
    }

    /// `claims.check` with `params` `{path, line}`. Whether a command may run is
    /// `commands` and nothing in `params`, so a host can decide it whatever its caller sent.
    pub fn run(&self, params: Value, commands: bool) -> Result<Value, Error> {
        let p: LineParams = parse("claims.check", params)?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs());
        Ok(json!(claims::check(&self.dir, &self.vault, note_path(&p.path)?, p.line, commands, now, claims::TIMEOUT)?))
    }
}

/// What the `git.*` and `review.*` operations need of the core, taken out of it by
/// [`Core::outside`], so that a host can run them without holding the core: they run git and
/// compare every note with a commit, which takes from tens of milliseconds to a second in a
/// large vault, and the window reads and saves notes meanwhile. They use nothing else of the
/// core: not the index, and of the vault only its folder.
pub struct Outside {
    /// The state folder, for the `review.*` operations.
    dir: Option<PathBuf>,
    vault: Vault,
}

impl Outside {
    /// Whether `name` is an operation that runs here: a host asks before it takes the core.
    pub fn has(name: &str) -> bool {
        name.starts_with("git.") || name.starts_with("review.")
    }

    /// Runs the operation `name`, as `Core::call` does (its table has the params and what is returned).
    pub fn run(&self, name: &str, params: Value) -> Result<Value, Error> {
        let vault = &self.vault;
        let dir = || self.dir.as_deref().ok_or(Error::NoStateFolder);
        match name {
            "git.log" => {
                let p: PathParam = parse(name, params)?;
                Ok(json!(git::log(vault.root(), git_path(vault, &p.path)?)))
            }
            "git.show" => {
                let p: ShowParams = parse(name, params)?;
                // Only a hash reaches git: not a branch, not `HEAD~1`, and nothing git could read as an option.
                let hash = |rev: &&str| (4..=64).contains(&rev.len()) && rev.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
                let rev = p.rev.as_deref();
                if rev.is_some() && rev.filter(hash).is_none() {
                    return Err(Error::BadParams(name.to_string(), "rev is not a commit hash".to_string()));
                }
                Ok(json!({ "content": git::show(vault.root(), git_path(vault, &p.path)?, rev) }))
            }
            "git.blame" => {
                let p: PathParam = parse(name, params)?;
                Ok(json!(git::blame(vault.root(), git_path(vault, &p.path)?)))
            }
            "review.list" => Ok(json!(review::list(dir()?, vault.root())?)),
            "review.base" => {
                let p: PathParam = parse(name, params)?;
                Ok(json!({ "content": review::base(dir()?, vault.root(), git_path(vault, &p.path)?)? }))
            }
            "review.accept" => {
                let p: AcceptParams = parse(name, params)?;
                let path = p.path.as_deref().map(|path| git_path(vault, path)).transpose()?;
                review::accept(dir()?, vault.root(), path)?;
                Ok(Value::Null)
            }
            "review.saved" => {
                let p: SavedParams = parse(name, params)?;
                review::saved(dir()?, vault.root(), git_path(vault, &p.path)?, &p.before, &p.after)?;
                Ok(Value::Null)
            }
            _ => Err(Error::UnknownCall(name.to_string())),
        }
    }
}

/// `claims.check`, without its `commands`.
#[derive(Deserialize)]
struct LineParams {
    path: String,
    line: usize,
}

/// `review.accept`: without a path, everything.
#[derive(Deserialize)]
struct AcceptParams {
    path: Option<String>,
}

#[derive(Deserialize)]
struct SavedParams {
    path: String,
    before: String,
    after: String,
}

#[derive(Deserialize)]
struct PathParam {
    path: String,
}

#[derive(Deserialize)]
struct WriteParams {
    path: String,
    content: String,
    base: Option<String>,
}

#[derive(Deserialize)]
struct CreateParams {
    path: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    own: bool,
}

#[derive(Deserialize)]
struct AttachmentParams {
    path: String,
    data: String,
}

/// `note.delete` and `folder.delete`.
#[derive(Deserialize)]
struct DeleteParams {
    path: String,
    #[serde(default)]
    own: bool,
}

#[derive(Deserialize)]
struct ResolveParams {
    link: String,
    from: String,
    #[serde(default)]
    files: bool,
}

#[derive(Deserialize)]
struct QueryParam {
    query: String,
}

#[derive(Deserialize)]
struct RankedParams {
    query: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct GraphNoteParams {
    path: String,
    depth: Option<usize>,
}

/// `graph.path`.
#[derive(Deserialize)]
struct EndsParams {
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct ShowParams {
    path: String,
    rev: Option<String>,
}

#[derive(Deserialize)]
struct RenameParams {
    from: String,
    to: String,
    #[serde(default)]
    own: bool,
}

impl Core {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the function that receives events from the core, replacing any
    /// earlier one. It is called on a background thread.
    ///
    /// There are two events, both for changes on disk in the open vault, the
    /// core's own writes included. Changes are grouped over about 250 ms.
    /// - `{"type": "vault.changed", "paths": [...]}`: notes and other files the app shows.
    /// - `{"type": "config.changed", "paths": [...]}`: files under `.inklode/`.
    pub fn set_listener(&self, listener: impl Fn(Value) + Send + Sync + 'static) {
        *self.listener.lock().unwrap() = Some(Box::new(listener));
    }

    /// Sets the folder for state that belongs to the user and not to a vault: the host's
    /// own data folder. The `review.*` operations keep a file per vault under `review/`
    /// in it, the `claims.*` operations one under `claims/`, and both fail with
    /// `NoStateFolder` without one. Hosts that give the same folder (the app and
    /// `inklode-mcp`) share that state.
    pub fn set_state_dir(&mut self, dir: impl Into<PathBuf>) {
        self.state_dir = Some(dir.into());
    }

    /// The folder of the open vault, as `vault.open` gave it.
    pub fn root(&self) -> Option<&Path> {
        self.vault.as_ref().map(Vault::root)
    }

    /// What `claims.check` needs, to run it after the core is let go of.
    pub fn claim_check(&self) -> Result<ClaimCheck, Error> {
        Ok(ClaimCheck { dir: self.state_dir.clone().ok_or(Error::NoStateFolder)?, vault: self.vault()?.clone() })
    }

    /// What the `git.*` and `review.*` operations need, to run them after the core is let go of.
    pub fn outside(&self) -> Result<Outside, Error> {
        Ok(Outside { dir: self.state_dir.clone(), vault: self.vault()?.clone() })
    }

    /// What `vault.health` needs, to run its git part after the core is let go of.
    pub fn health_check(&mut self) -> Result<health::HealthCheck, Error> {
        let cache = self.health_logs.clone();
        let (_, index) = self.fresh()?;
        Ok(health::check(index, health::roots(), cache))
    }

    /// Runs one named operation with JSON params and returns JSON.
    ///
    /// Paths are relative to the vault root and use forward slashes.
    ///
    /// Dot names (`.git`, `.obsidian`, `.trash`, `.inklode`, `.env`): a path with a
    /// part that starts with a dot is refused by every `note.*` and `folder.*`
    /// operation, with `BadPath` (`folder.rename`: `BadMove`, `folder.delete`:
    /// `NotFound`), and the tree, the index and search leave such files out. The
    /// only way to them is `config.read`, `config.write` and `config.list`, which
    /// reach `.inklode/` and nothing else.
    ///
    /// The `git.*` operations read the history of the repository the vault is in, by
    /// running `git`, and never write. Their `path` is checked like a note's. With no
    /// repository, no `git` program, or a file that was never committed, the lists are
    /// empty and `content` is null.
    ///
    /// The `review.*` operations are the inbox of notes changed since the user last
    /// looked (review.rs). Like the `git.*` operations they use only the vault's folder, so a
    /// host that shares the core runs both kinds as [`Core::outside`] and [`Outside::run`], to let
    /// go of the core while git runs. They read git and never write to the repository or the vault;
    /// what was seen is kept in the state folder (`set_state_dir`). `base` is a commit:
    /// the last one when review is first used in a vault, so nothing waits then, not
    /// even what is uncommitted at that moment. A note that was accepted with another
    /// text than it has at `base` is compared with that text from then on.
    ///
    /// `own` (false if left out) on `note.create`, the renames and the deletes says that
    /// the user did this in the app. What it changes is then accepted for review and does
    /// not wait: the notes that moved, were deleted or made, and the notes whose links a
    /// rename rewrote. A note that was waiting before stays waiting. It does nothing in a
    /// vault where review was never used. Tools for agents must not pass it on.
    ///
    /// The `claims.*` operations are about the lines of notes that name their evidence in
    /// a `<!-- check: … -->` at their end (claims.rs). The results of checks are kept in the
    /// state folder and nothing is written into the vault. `claims.check` is the only
    /// operation of the core that runs a program a note names, and only with `commands`:
    /// a host must not take that from whoever asks. The app sets it from its own settings
    /// (src-tauri/src/lib.rs) and no MCP tool reaches the operation.
    ///
    /// | name             | params            | returns                           |
    /// |------------------|-------------------|-----------------------------------|
    /// | `vault.open`     | `{path}` absolute | `{root, name, watchError}`: `watchError` is null, or why changes made on disk by other programs will not be reported (the vault is open all the same) |
    /// | `vault.tree`     | none              | list of [`crate::Entry`]          |
    /// | `note.read`      | `{path}`          | `{content}`                       |
    /// | `note.write`     | `{path, content, base?}` | `null`. Creates or replaces the file. With `base`, the text the caller last read or wrote, it fails with `Conflict` and writes nothing unless the file still holds exactly that, byte for byte; a missing file counts as empty |
    /// | `note.create`    | `{path, content?, own?}` | `null`. Makes a new file and the folders above it; fails with `Exists` if anything has the path, also under another case or Unicode normal form where the disk ignores those |
    /// | `attachment.create` | `{path, data}` | `null`. `note.create` for a file that is not text, such as a pasted image: `data` is its bytes in base64 |
    /// | `attachment.read` | `{path}` | `{data}`: `note.read` for a file that is not text, such as a PDF: `data` is its bytes in base64 |
    /// | `config.read`    | `{path}`          | `{content}`. `path` is `.inklode/…`, with no other dot name in it |
    /// | `config.write`   | `{path, content}` | `null`. `path` as for `config.read` |
    /// | `note.resolve`   | `{link, from, files?}` | `{path}`, null if no note matches. With `files: true`, a link that reaches no note may reach a file that is not a note, such as a PDF, found as an embed's file is: next to `from`, then from the vault root |
    /// | `note.backlinks` | `{path}`          | list of `{path, line, text}`      |
    /// | `note.rename`    | `{from, to, own?}` | `{updated}`: the notes that did not move and had links rewritten. Any file, not only a note: an image's embeds are rewritten too. `from` may be spelled in another case or normal form than on disk, where the disk ignores those. Fails with `BadName`, before anything moves, when the new name (or a folder the move would make) has one of `[ ] # \| ^` or starts or ends with a space, since no link could say it. The notes are rewritten together (`Vault::write_all`), each through a temporary file that is flushed to the disk first; one that another program changed while the rename ran keeps its old links, and the rename then fails with `Conflict` after the others are done |
    /// | `folder.rename`  | `{from, to, own?}` | `{updated}`, as `note.rename`. The folder moves with everything in it; `to` must not exist, be inside `from`, or be in a dot folder |
    /// | `folder.delete`  | `{path, own?}`    | `{trashed}`: the folder moves whole under `.trash/`, as `note.delete` moves a file |
    /// | `folder.new`     | `{path}`          | `null`. Makes an empty folder; fails if the path is taken |
    /// | `note.delete`    | `{path, own?}`    | `{trashed}`: where the file is now, under `.trash/` at the vault root; nothing is unlinked |
    /// | `search`         | `{query}`       | list of `{path, line, text}`, `line` 0 for a file-name match |
    /// | `search.ranked`  | `{query, limit?}` | list of `{path, score, lines}`, best first, at most `limit` (10 if left out, 1 to 50): the notes that have a word of the query, as a whole word in any case, in their text or file name (rank.rs). The score is BM25 over the note's words, plus more for a query word in the file name, the frontmatter `aliases` or `tags`, or a heading. Notes with every word of the query come before the others whatever the scores. `lines` are the note's lines that say most of the query, at most 3, as `{line, text}` like `search` gives them, in note order |
    /// | `config.list`    | none              | `{themes, snippets}`: names of the `.css` files in `.inklode/themes` and `.inklode/snippets`, without extension |
    /// | `vault.graph`    | none              | `{nodes, edges, unresolved, attachments}`: every note as `{path, links, tags?}` (`links` counts its edges; `tags` are its frontmatter `tags` and the `#tags` of its text, without `#`, left out when it has none), an edge `{from, to}` for each note that links to another, the link targets that reach nothing as `{name, from}` and the files that are not notes and that a note links to or embeds as `{path, from}`, `from` being positions in `nodes` |
    /// | `graph.note`     | `{path, depth?}`  | `{path, links, backlinks, unresolved}` (graph.rs): the paths of the notes it links to or embeds, of those that link to it, and the targets of its links that reach no note and no file, as written. `depth` is 1 (if left out), 2 or 3, else `BadParams`; above 1 there is also `near`, the notes 2 to `depth` links away in either direction as `{path, distance}`, nearest first, at most 200, and `nearTotal`, how many there are. `NotFound` when no note has the path |
    /// | `graph.path`     | `{from, to}`      | `{found, path, steps}`: a shortest chain of notes from `from` to `to` where each is joined to the next by a link in either of the two. `path` is the notes in order, `steps` one `{from, to, linkIn}` per pair, `linkIn` being the note the link is written in. With no chain `found` is false and both lists are empty. `NotFound` when one of the two is not a note |
    /// | `vault.health`   | none              | `{broken, orphans, stale, unchecked}` (health.rs). `broken`: the notes with links or embeds that reach no note and no file, by path, each `{path, links}` with `links` as `{line, link, text}` (`link` is the text between the brackets). `orphans`: the paths of the notes with no link to another note and none from one. `stale`: `{path, updated, repo, dir, commits, newest}` for each note and entry of its frontmatter `repos:` whose repository has commits on its default branch dated after the note's `updated:` day (an entry `name:dir` counts the commits under `dir`, `name:!dir` those outside it; commits of housekeeping files alone do not count); `repo` is the entry as written, `dir` the repository's root, `commits` how many there are and `newest` the last of them as `{date, rev, subject}` with the short hash. `unchecked`: `{path, repo, reason}` for a `repos:` entry that is not the root of a git repository, and with `repo` null for a note with `repos:` and no valid `updated:`. Runs `git log` in those repositories and writes nothing; the commits read are kept while a repository's default branch stays at the same commit, so a report on repositories that did not change asks each only where that branch is. A host that shares the core runs it as `Core::health_check` and `HealthCheck::run`, to let go of the core while git runs |
    /// | `vault.tasks`    | none              | list of `{path, tasks}`, by path: the notes with open checkboxes (`- [ ]`, also after `*`, `+`, `1.` and `1)`) outside fenced code blocks, `tasks` as `{line, text}` with `line` from 1 |
    /// | `git.log`        | `{path}`          | list of `{rev, author, date, subject}`: the commits that changed the file, newest first, through renames. `rev` is the full hash, `date` the author date as ISO 8601 |
    /// | `git.show`       | `{path, rev?}`    | `{content}`: the file's text in the commit `rev` (a hash of 4 to 64 hex digits, else `BadParams`), under the name it had then; without `rev`, in the last commit. Null when there is no such version |
    /// | `git.blame`      | `{path}`          | list of `{from, to, rev, author, date, subject}`: for the file as last committed, the commit that last changed lines `from` to `to` (1-based, inclusive). Lines next to each other from one commit are one entry |
    /// | `review.list`    | none              | `{repository, entries}`. `entries`: the notes (`.md`, no dot paths) whose text on disk differs from the text the user last saw (the accepted one, else that at `base`), by path, each `{path, status, added, removed, commits, uncommitted}`: `status` is `changed`, `added` or `deleted`; `added` and `removed` count lines against the text last seen; `commits` are those since `base` that changed it, newest first, as `git.log` gives them; `uncommitted` says whether the text on disk is not the last commit's. Committed and uncommitted changes, untracked notes and deleted notes are all in it. `repository` is false, with no entries, when the vault is not in a git repository with a commit |
    /// | `review.base`    | `{path}`          | `{content}`: the text the note is compared with and a reject goes back to: the one last accepted, else the one at `base`. Null when there was no note then |
    /// | `review.accept`  | `{path?}`         | `null`. Marks the text the note has on disk now as seen, and keeps it to compare with; a note that is gone is accepted as deleted. Without `path`, everything: `base` becomes the last commit and what is uncommitted is accepted as it is |
    /// | `review.saved`   | `{path, before, after}` | `null`. For the app, after it wrote the user's own edit `after` over `before`: if `before` was not waiting for review, `after` is accepted, so the user's typing does not fill the inbox. A note that was waiting stays |
    /// | `claims.list`    | none              | list of `{path, line, text, evidence, kind, status, checked, output}`, by path then line: every claim outside code. `line` is from 1, `text` the line without its marker (trimmed, cut at 200 characters), `evidence` the marker's text after `check:`, `kind` `command`, `file` or `url`. `status` is `unchecked` (never checked), `failing` (the last check failed), `stale` (it passed, but more than 30 days ago, or the file of a `file` claim has another content now or is gone) or `passing`. `checked` is the day of the last check (`YYYY-MM-DD`, UTC) and `output` what it printed or why it failed, at most 2000 characters; both null when never checked. Reads only: runs no command and fetches no URL |
    /// | `claims.check`   | `{path, line, commands?}` | the claim on that line as `claims.list` gives it, after checking its evidence and keeping the result. `file`: passes when the file can be read. `url`: passes when `/usr/bin/curl` gets a 2xx within 10 s, redirects followed. `command`: run with `/bin/sh -c` in the vault's folder, or the one after ` @ `, stdin closed, and passes on exit status 0 within 120 s. Without `commands: true` a `command` claim fails with `commands are not allowed for this vault` and nothing runs. Fails when the line has no claim |
    pub fn call(&mut self, name: &str, params: Value) -> Result<Value, Error> {
        match name {
            "vault.open" => {
                let p: PathParam = parse(name, params)?;
                let vault = Vault::open(&p.path)?;
                // Watch before scanning, so a change made during the scan is not missed.
                // If watching fails the vault still opens; `fresh` then rescans on every query,
                // and the caller is told, because no change event will come.
                let watching = watch(vault.root(), self.dirty.clone(), self.listener.clone());
                let watch_error = watching.as_ref().err().map(|e| e.to_string());
                let info = json!({ "root": vault.root(), "name": vault.name(), "watchError": watch_error });
                self.watcher = watching.ok();
                self.dirty.store(false, Ordering::SeqCst);
                self.index = Some(Index::build(&vault)?);
                self.vault = Some(vault);
                Ok(info)
            }
            "vault.tree" => Ok(json!(self.vault()?.tree()?)),
            "note.read" => {
                let p: PathParam = parse(name, params)?;
                Ok(json!({ "content": self.vault()?.read(note_path(&p.path)?)? }))
            }
            "note.write" => {
                let p: WriteParams = parse(name, params)?;
                self.vault()?.write_over(note_path(&p.path)?, &p.content, p.base.as_deref())?;
                // The watcher reports this write too, but only after its delay.
                self.dirty.store(true, Ordering::SeqCst);
                Ok(Value::Null)
            }
            "note.create" => {
                let p: CreateParams = parse(name, params)?;
                let vault = self.vault()?;
                let dir = self.state_dir.as_deref().filter(|_| p.own);
                let settled = review::settled(dir, vault.root(), git_path(vault, &p.path).ok());
                vault.create(&p.path, &p.content)?;
                review::accept_own(dir, vault.root(), &settled);
                self.dirty.store(true, Ordering::SeqCst);
                Ok(Value::Null)
            }
            // A new file that is not a note, such as a pasted image: `data` is its bytes in base64.
            "attachment.create" => {
                let p: AttachmentParams = parse(name, params)?;
                let bytes = BASE64.decode(&p.data).map_err(|e| Error::BadParams(name.to_string(), e.to_string()))?;
                self.vault()?.create_bytes(&p.path, &bytes)?;
                self.dirty.store(true, Ordering::SeqCst);
                Ok(Value::Null)
            }
            // A file that is not a note, such as a PDF the window draws itself.
            "attachment.read" => {
                let p: PathParam = parse(name, params)?;
                Ok(json!({ "data": BASE64.encode(self.vault()?.read_bytes(note_path(&p.path)?)?) }))
            }
            // Config files are not notes, so a write needs no reindex.
            "config.read" => {
                let p: PathParam = parse(name, params)?;
                Ok(json!({ "content": self.vault()?.read(config_path(&p.path)?)? }))
            }
            "config.write" => {
                let p: WriteParams = parse(name, params)?;
                self.vault()?.write(config_path(&p.path)?, &p.content)?;
                Ok(Value::Null)
            }
            "note.resolve" => {
                let p: ResolveParams = parse(name, params)?;
                let (_, index) = self.fresh()?;
                let path = if p.files { index.file_of(&p.link, &p.from) } else { index.resolve(&p.link, &p.from) };
                Ok(json!({ "path": path }))
            }
            "note.backlinks" => {
                let p: PathParam = parse(name, params)?;
                let (_, index) = self.fresh()?;
                Ok(json!(index.backlinks(&p.path)))
            }
            "search" => {
                let p: QueryParam = parse(name, params)?;
                let (_, index) = self.fresh()?;
                Ok(json!(index.search(&p.query)))
            }
            "search.ranked" => {
                let p: RankedParams = parse(name, params)?;
                let (_, index) = self.fresh()?;
                Ok(json!(rank::search(index, &p.query, p.limit.unwrap_or(10).clamp(1, 50))))
            }
            "graph.note" => {
                let p: GraphNoteParams = parse(name, params)?;
                let depth = p.depth.unwrap_or(1);
                if !(1..=3).contains(&depth) {
                    return Err(Error::BadParams(name.to_string(), "depth is 1, 2 or 3".to_string()));
                }
                let (_, index) = self.fresh()?;
                Ok(json!(graph::note(index, note_path(&p.path)?, depth)?))
            }
            "graph.path" => {
                let p: EndsParams = parse(name, params)?;
                let (_, index) = self.fresh()?;
                Ok(json!(graph::path(index, note_path(&p.from)?, note_path(&p.to)?)?))
            }
            "vault.graph" => {
                let (_, index) = self.fresh()?;
                Ok(json!(index.graph()))
            }
            "vault.health" => Ok(json!(self.health_check()?.run())),
            "vault.tasks" => {
                let (_, index) = self.fresh()?;
                Ok(json!(index.tasks()))
            }
            "note.rename" | "folder.rename" => {
                let p: RenameParams = parse(name, params)?;
                let dir = self.state_dir.clone().filter(|_| p.own);
                // Always from an index read from disk now. The watcher sets `dirty` only
                // after its delay, so an index `fresh` takes for current can lack a note or
                // a link another program wrote a moment ago, and that link would not be rewritten.
                self.dirty.store(true, Ordering::SeqCst);
                let (vault, index) = self.fresh()?;
                // The index knows each file by its name on disk. A `from` that reaches
                // it under another spelling would move the file and match no path in the
                // index, so no link would be rewritten.
                let from = vault.spelled(&p.from)?;
                if vault.is_folder(&from) != (name == "folder.rename") {
                    return Err(Error::NotFound(p.from));
                }
                link_name(vault, &p.to)?;
                // The index still describes the vault before the move, which is
                // what tells us where each old link pointed.
                let after = index.relocated(&from, &p.to);
                // Refused before anything moves when a link could not be kept on its note.
                for note in index.affected(&from, &p.to) {
                    index.rewrite_links(&after, note, index.content(note), &from, &p.to)?;
                }
                // The move is one rename on disk, a folder with
                // everything in it included: it happens whole or not at all, and no
                // link is ever rewritten for a file that did not move.
                let settled = review::settled(dir.as_deref(), vault.root(), index.affected(&from, &p.to));
                vault.rename(&from, &p.to)?;
                let notes = index.affected(&from, &p.to);
                // Each note that has links to rewrite, as its path now, the text it has and the text it gets.
                // Read from disk, not from the index, so an edit the watcher has not reported yet is kept.
                let rewrite = |note: &&str| -> Result<Option<(String, String, String)>, Error> {
                    let path = relocate(note, &from, &p.to);
                    let content = vault.read(&path)?;
                    Ok(index.rewrite_links(&after, note, &content, &from, &p.to)?.map(|text| (path, content, text)))
                };
                let rewritten: Vec<_> = notes.iter().map(rewrite).collect();
                // Written together (`Vault::write_all`), which is what makes a rename of a note that a thousand
                // notes link to take a second and not nine. A note that another program changed since it was
                // read here is not written over: it fails with `Conflict` and keeps its old links.
                let written = {
                    let writes: Vec<Write> = rewritten.iter().flatten().flatten().map(|(path, content, text)| Write { path, content: text, base: Some(content) }).collect();
                    vault.write_all(&writes)
                };
                let mut written = written.into_iter();
                let mut updated = Vec::new();
                let mut failed = None;
                for (note, rewritten) in notes.iter().zip(rewritten) {
                    let done = match rewritten {
                        Ok(Some((path, ..))) => written.next().expect("one answer per write").map(|()| path == *note),
                        Ok(None) => Ok(false),
                        Err(e) => Err(e),
                    };
                    match done {
                        Ok(true) => updated.push(note.to_string()),
                        Ok(false) => {}
                        // A note that cannot be rewritten keeps its old links. The
                        // others are still done, so as few links as possible are left broken.
                        // The failure reported is that of the first such note in the order of the index.
                        Err(e) => failed = failed.or(Some(e)),
                    }
                }
                // A note that moved is gone at its old path and new at the other.
                let own: Vec<String> = settled.iter().flat_map(|path| [relocate(path, &from, &p.to), path.clone()]).collect();
                review::accept_own(dir.as_deref(), vault.root(), &own);
                self.dirty.store(true, Ordering::SeqCst);
                match failed {
                    Some(e) => Err(e),
                    None => Ok(json!({ "updated": updated })),
                }
            }
            "note.delete" => {
                let p: DeleteParams = parse(name, params)?;
                let vault = self.vault()?;
                let dir = self.state_dir.as_deref().filter(|_| p.own);
                let settled = review::settled(dir, vault.root(), git_path(vault, &p.path).ok());
                let trashed = vault.trash(&p.path)?;
                review::accept_own(dir, vault.root(), &settled);
                self.dirty.store(true, Ordering::SeqCst);
                Ok(json!({ "trashed": trashed }))
            }
            "folder.delete" => {
                let p: DeleteParams = parse(name, params)?;
                let dir = self.state_dir.clone().filter(|_| p.own);
                // Only asked for the user's own delete: the notes in the folder.
                let inside = match dir {
                    Some(_) => self.fresh()?.1.paths().filter(|path| relocate(path, &p.path, "") != *path).map(str::to_string).collect(),
                    None => Vec::new(),
                };
                let vault = self.vault()?;
                let settled = review::settled(dir.as_deref(), vault.root(), inside.iter().map(String::as_str));
                let trashed = vault.trash_folder(&p.path)?;
                review::accept_own(dir.as_deref(), vault.root(), &settled);
                self.dirty.store(true, Ordering::SeqCst);
                Ok(json!({ "trashed": trashed }))
            }
            "folder.new" => {
                let p: PathParam = parse(name, params)?;
                self.vault()?.create_folder(&p.path)?;
                Ok(Value::Null)
            }
            "config.list" => {
                let vault = self.vault()?;
                Ok(json!({
                    "themes": vault.css_names(".inklode/themes")?,
                    "snippets": vault.css_names(".inklode/snippets")?,
                }))
            }
            // They need the vault's folder and the state folder and nothing else of the core, so a
            // host that shares the core runs them as `Core::outside` and `Outside::run`, without holding it.
            name if Outside::has(name) => self.outside()?.run(name, params),
            "claims.list" => {
                let dir = self.state_dir.clone().ok_or(Error::NoStateFolder)?;
                let (vault, index) = self.fresh()?;
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs());
                Ok(json!(claims::list(&dir, vault.root(), index.texts(), now)))
            }
            "claims.check" => {
                // Only `true` in an object allows commands: params in any other form allow none.
                let commands = params.get("commands").and_then(Value::as_bool) == Some(true);
                self.claim_check()?.run(params, commands)
            }
            _ => Err(Error::UnknownCall(name.to_string())),
        }
    }

    fn vault(&self) -> Result<&Vault, Error> {
        self.vault.as_ref().ok_or(Error::NoVault)
    }

    /// The vault with an index that matches the disk, rescanning if anything changed.
    fn fresh(&mut self) -> Result<(&Vault, &Index), Error> {
        let vault = self.vault.as_ref().ok_or(Error::NoVault)?;
        let changed = self.dirty.swap(false, Ordering::SeqCst);
        if changed || self.watcher.is_none() || self.index.is_none() {
            self.index = Some(Index::build(vault)?);
        }
        Ok((vault, self.index.as_ref().expect("index was just built")))
    }
}

/// `path` if the note operations may touch it: nothing under a dot name.
fn note_path(path: &str) -> Result<&str, Error> {
    if hidden(path) { Err(Error::BadPath(path.to_string())) } else { Ok(path) }
}

/// Refuses `to` as the path a rename gives a file or folder when no `[[link]]` can say
/// it. `[`, `]`, `#`, `|` and `^` end or split what is between a link's brackets, and
/// a link is read without the spaces around its target (for a note, the name without
/// `.md`). The last part of `to` is checked, and each folder the move would make. A
/// folder that is there already is not: a file may still move into `C# notes`.
fn link_name(vault: &Vault, to: &str) -> Result<(), Error> {
    let parts: Vec<&str> = to.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        if !last && vault.is_folder(&parts[..=i].join("/")) {
            continue;
        }
        if let Some(c) = part.chars().find(|c| "[]#|^".contains(*c)) {
            return Err(Error::BadName(to.to_string(), format!("contain \"{c}\", which has a meaning inside a [[link]]")));
        }
        let lower = part.to_lowercase();
        let said = if last { lower.strip_suffix(".md").unwrap_or(&lower) } else { &lower };
        if part.trim() != *part || said.trim() != said {
            return Err(Error::BadName(to.to_string(), "start or end with a space, which a [[link]] does not keep".to_string()));
        }
    }
    Ok(())
}

/// `path` if git may be asked about it: what `note_path` lets through, and inside the vault.
fn git_path<'a>(vault: &Vault, path: &'a str) -> Result<&'a str, Error> {
    vault.resolve(note_path(path)?)?;
    Ok(path)
}

/// `path` if it is one of the app's own files: in `.inklode/`, with no other dot name.
fn config_path(path: &str) -> Result<&str, Error> {
    match path.strip_prefix(".inklode/") {
        Some(rest) if !hidden(rest) => Ok(path),
        _ => Err(Error::BadPath(path.to_string())),
    }
}

fn parse<T: DeserializeOwned>(name: &str, params: Value) -> Result<T, Error> {
    serde_json::from_value(params).map_err(|e| Error::BadParams(name.to_string(), e.to_string()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn open_read_write_through_call() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "one").unwrap();
        let mut core = Core::new();

        assert!(matches!(core.call("vault.tree", Value::Null), Err(Error::NoVault)));

        let info = core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        assert_eq!(info["name"], dir.path().file_name().unwrap().to_str().unwrap());
        assert_eq!(info["watchError"], Value::Null);
        assert!(info.as_object().unwrap().contains_key("watchError"));

        let tree = core.call("vault.tree", Value::Null).unwrap();
        assert_eq!(tree, json!([{ "name": "a.md", "path": "a.md" }]));

        core.call("note.write", json!({ "path": "a.md", "content": "two" })).unwrap();
        let read = core.call("note.read", json!({ "path": "a.md" })).unwrap();
        assert_eq!(read, json!({ "content": "two" }));
    }

    #[test]
    fn bad_calls_are_errors() {
        let mut core = Core::new();
        assert!(matches!(core.call("nope", Value::Null), Err(Error::UnknownCall(_))));
        assert!(matches!(
            core.call("vault.open", json!({})),
            Err(Error::BadParams(..))
        ));
        assert!(matches!(core.call("search", json!({ "query": "x" })), Err(Error::NoVault)));
    }

    #[test]
    fn resolve_backlinks_and_search_through_call() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".obsidian")).unwrap();
        fs::write(dir.path().join("Home.md"), "# Home\n").unwrap();
        fs::write(dir.path().join("a.md"), "go [[home]]\n").unwrap();
        fs::write(dir.path().join(".obsidian/x.md"), "[[Home]] hidden\n").unwrap();
        fs::write(dir.path().join("pic.png"), "[[Home]]").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();

        let resolved = core.call("note.resolve", json!({ "link": "home#Top|x", "from": "a.md" })).unwrap();
        assert_eq!(resolved, json!({ "path": "Home.md" }));
        let missing = core.call("note.resolve", json!({ "link": "nope", "from": "a.md" })).unwrap();
        assert_eq!(missing, json!({ "path": null }));
        // A file that is not a note only with `files`.
        assert_eq!(core.call("note.resolve", json!({ "link": "pic.png", "from": "a.md" })).unwrap(), json!({ "path": null }));
        let file = core.call("note.resolve", json!({ "link": "pic.png", "from": "a.md", "files": true })).unwrap();
        assert_eq!(file, json!({ "path": "pic.png" }));
        let note = core.call("note.resolve", json!({ "link": "home", "from": "a.md", "files": true })).unwrap();
        assert_eq!(note, json!({ "path": "Home.md" }));

        let backlinks = core.call("note.backlinks", json!({ "path": "Home.md" })).unwrap();
        assert_eq!(backlinks, json!([{ "path": "a.md", "line": 1, "text": "go [[home]]" }]));

        let graph = core.call("vault.graph", Value::Null).unwrap();
        assert_eq!(
            graph,
            json!({
                "nodes": [{ "path": "Home.md", "links": 1 }, { "path": "a.md", "links": 1 }],
                "edges": [{ "from": "a.md", "to": "Home.md" }],
                "unresolved": [],
                "attachments": [],
            })
        );

        // A note written through the core is found by the next query.
        core.call("note.write", json!({ "path": "b.md", "content": "x\nsee [[Home]]\n" })).unwrap();
        let ranked = core.call("search.ranked", json!({ "query": "home hidden", "limit": 2 })).unwrap();
        assert_eq!(ranked.as_array().unwrap().len(), 2);
        assert_eq!((&ranked[0]["path"], &ranked[0]["lines"]), (&json!("Home.md"), &json!([{ "line": 1, "text": "# Home" }])));
        assert!(ranked[0]["score"].as_f64().unwrap() > ranked[1]["score"].as_f64().unwrap());
        // No limit can ask for nothing or for everything.
        assert_eq!(core.call("search.ranked", json!({ "query": "home", "limit": 0 })).unwrap().as_array().unwrap().len(), 1);
        assert!(matches!(core.call("search.ranked", json!({ "query": "home", "limit": "2" })), Err(Error::BadParams(..))));

        let around = core.call("graph.note", json!({ "path": "Home.md" })).unwrap();
        assert_eq!(around, json!({ "path": "Home.md", "links": [], "backlinks": ["a.md", "b.md"], "unresolved": [] }));
        let around = core.call("graph.note", json!({ "path": "a.md", "depth": 2 })).unwrap();
        assert_eq!(around, json!({ "path": "a.md", "links": ["Home.md"], "backlinks": [], "unresolved": [], "near": [{ "path": "b.md", "distance": 2 }], "nearTotal": 1 }));
        for depth in [0, 4] {
            assert!(matches!(core.call("graph.note", json!({ "path": "a.md", "depth": depth })), Err(Error::BadParams(..))));
        }
        let route = core.call("graph.path", json!({ "from": "a.md", "to": "b.md" })).unwrap();
        assert_eq!(
            route,
            json!({
                "found": true,
                "path": ["a.md", "Home.md", "b.md"],
                "steps": [{ "from": "a.md", "to": "Home.md", "linkIn": "a.md" }, { "from": "Home.md", "to": "b.md", "linkIn": "b.md" }],
            })
        );
        // The hidden note is not in the graph, and a dot path is refused like any note path.
        assert!(matches!(core.call("graph.note", json!({ "path": ".obsidian/x.md" })), Err(Error::BadPath(_))));
        assert!(matches!(core.call("graph.path", json!({ "from": "a.md", "to": ".obsidian/x.md" })), Err(Error::BadPath(_))));
        assert!(matches!(core.call("graph.note", json!({ "path": "pic.png" })), Err(Error::NotFound(_))));
        let found = core.call("search", json!({ "query": "HOME" })).unwrap();
        assert_eq!(
            found,
            json!([
                { "path": "Home.md", "line": 0, "text": "" },
                { "path": "Home.md", "line": 1, "text": "# Home" },
                { "path": "a.md", "line": 1, "text": "go [[home]]" },
                { "path": "b.md", "line": 2, "text": "see [[Home]]" },
            ])
        );
    }

    #[test]
    fn rename_right_after_a_change_made_outside_rewrites_the_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("Home.md"), "home\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        // Another program makes a note and a link to it, and the rename comes before the
        // watcher has reported either.
        fs::write(root.join("New.md"), "new\n").unwrap();
        fs::write(root.join("Home.md"), "home [[New]]\n").unwrap();
        let result = core.call("note.rename", json!({ "from": "New.md", "to": "Renamed.md" })).unwrap();
        assert_eq!(result, json!({ "updated": ["Home.md"] }));
        assert_eq!(fs::read_to_string(root.join("Home.md")).unwrap(), "home [[Renamed]]\n");
    }

    #[test]
    fn a_rename_rewrites_the_links_of_every_note_however_many_link_to_it() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Hub.md"), "# Hub\nsee [[Hub#Top]]\n").unwrap();
        fs::write(dir.path().join("Other.md"), "other\n").unwrap();
        // More notes than are written at once, in several folders, each with its own text around its links.
        let count = 150;
        let path = |n: usize| format!("f{}/n{n:03}.md", n % 6);
        let text = |n: usize, to: &str| match n % 5 {
            // Not a link to the hub: the note is left alone.
            0 => format!("note {n} about [[Other]] and Hub\n"),
            1 => format!("note {n}\n- [ ] read [[{to}|the hub]] twice: [[{to}#Top]]\n{}", "filler line\n".repeat(n)),
            _ => format!("note {n} links to [[{to}]] and [[Other]]\n"),
        };
        for n in 0..count {
            fs::create_dir_all(dir.path().join(path(n)).parent().unwrap()).unwrap();
            fs::write(dir.path().join(path(n)), text(n, "Hub")).unwrap();
        }
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        let out = core.call("note.rename", json!({ "from": "Hub.md", "to": "f1/Nexus.md" })).unwrap();
        let mut linking: Vec<String> = (0..count).filter(|n| n % 5 != 0).map(path).collect();
        linking.sort();
        assert_eq!(out["updated"], json!(linking));
        for n in 0..count {
            assert_eq!(fs::read_to_string(dir.path().join(path(n))).unwrap(), text(n, "Nexus"), "{}", path(n));
        }
        assert_eq!(fs::read_to_string(dir.path().join("f1/Nexus.md")).unwrap(), "# Hub\nsee [[Nexus#Top]]\n");
        assert_eq!(core.call("note.backlinks", json!({ "path": "f1/Nexus.md" })).unwrap().as_array().unwrap().len(), count - count / 5);
        // And back, to a name in another folder than most of the notes are in.
        core.call("note.rename", json!({ "from": "f1/Nexus.md", "to": "Hub.md" })).unwrap();
        for n in 0..count {
            assert_eq!(fs::read_to_string(dir.path().join(path(n))).unwrap(), text(n, "Hub"), "{}", path(n));
        }
    }

    #[test]
    fn rename_refuses_a_name_that_a_link_cannot_say() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("C# notes")).unwrap();
        fs::write(root.join("src.md"), "body\n").unwrap();
        fs::write(root.join("linker.md"), "[[src]]\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        let refused = [
            ("A#B.md", "\"#\""),
            ("A|B.md", "\"|\""),
            ("A]]B.md", "\"]\""),
            ("A [1].md", "\"[\""),
            ("A^B.md", "\"^\""),
            (" lead.md", "space"),
            ("trail .md", "space"),
            ("trail.md ", "space"),
            ("new#folder/src.md", "\"#\""),
        ];
        for (to, named) in refused {
            let error = core.call("note.rename", json!({ "from": "src.md", "to": to })).unwrap_err();
            assert!(matches!(error, Error::BadName(..)), "{to}: {error}");
            assert!(error.to_string().contains(named), "{to}: {error}");
            // Nothing moved and no link was touched.
            assert!(root.join("src.md").exists(), "{to}");
            assert_eq!(fs::read_to_string(root.join("linker.md")).unwrap(), "[[src]]\n", "{to}");
        }
        fs::create_dir_all(root.join("dir")).unwrap();
        let folder = core.call("folder.rename", json!({ "from": "dir", "to": "dir [old]" })).unwrap_err();
        assert!(matches!(folder, Error::BadName(..)), "{folder}");
        assert!(root.join("dir").is_dir());

        // Other characters are fine, and so is a move into a folder that already has such a name.
        core.call("note.rename", json!({ "from": "src.md", "to": "C++ 100% (a).md" })).unwrap();
        assert_eq!(fs::read_to_string(root.join("linker.md")).unwrap(), "[[C++ 100% (a)]]\n");
        core.call("note.rename", json!({ "from": "C++ 100% (a).md", "to": "C# notes/src.md" })).unwrap();
        assert!(root.join("C# notes/src.md").exists());
    }

    #[test]
    fn rename_moves_the_note_and_rewrites_links_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("Old.md"), "me: [[Old#Top]]\n").unwrap();
        fs::write(root.join("a.md"), "[[Old]] [[old#H|Alias]] ![[Old]] [[Other]]\n").unwrap();
        fs::write(root.join("sub/b.md"), "path style [[/Old.md#H]] and `[[Old]]`\n").unwrap();
        fs::write(root.join("Other.md"), "no links to it, mentions Old\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        let modified = |name: &str| fs::metadata(root.join(name)).unwrap().modified().unwrap();
        let other_before = modified("Other.md");

        let taken = core.call("note.rename", json!({ "from": "Old.md", "to": "Other.md" }));
        assert!(matches!(taken, Err(Error::Exists(_))));
        let missing = core.call("note.rename", json!({ "from": "nope.md", "to": "x.md" }));
        assert!(matches!(missing, Err(Error::NotFound(_))));
        let outside = core.call("note.rename", json!({ "from": "Old.md", "to": "../x.md" }));
        assert!(matches!(outside, Err(Error::BadPath(_))));

        let result = core.call("note.rename", json!({ "from": "Old.md", "to": "deep/er/New.md" })).unwrap();
        assert_eq!(result, json!({ "updated": ["a.md", "sub/b.md"] }));

        let read = |name: &str| fs::read_to_string(root.join(name)).unwrap();
        assert!(!root.join("Old.md").exists());
        assert_eq!(read("deep/er/New.md"), "me: [[New#Top]]\n");
        assert_eq!(read("a.md"), "[[New]] [[New#H|Alias]] ![[New]] [[Other]]\n");
        assert_eq!(read("sub/b.md"), "path style [[deep/er/New#H]] and `[[Old]]`\n");
        assert_eq!(modified("Other.md"), other_before, "a note without links to it must not be rewritten");

        // The index follows the rename.
        let backlinks = core.call("note.backlinks", json!({ "path": "deep/er/New.md" })).unwrap();
        assert_eq!(backlinks.as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_folder_moves_with_its_files_and_only_notes_that_need_it_are_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("Work/sub")).unwrap();
        fs::create_dir_all(root.join("Archive")).unwrap();
        fs::write(root.join("Work/Plan.md"), "next: [[Tasks]] ![[pic.png]] ![[Work/pic.png]]\n").unwrap();
        fs::write(root.join("Work/sub/Tasks.md"), "back: [[Plan]]\n").unwrap();
        fs::write(root.join("Work/sketch.excalidraw.md"), "drawing\n").unwrap();
        fs::write(root.join("Work/pic.png"), [0u8, 159, 146, 150]).unwrap();
        fs::write(root.join("Home.md"), "[[Plan]] [[Work/Plan|the plan]] ![[sketch.excalidraw]] [[sub/Tasks]]\n").unwrap();
        fs::write(root.join("Bare.md"), "[[Plan]] [[Tasks#Today]] ![[sketch.excalidraw]]\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        let modified = |name: &str| fs::metadata(root.join(name)).unwrap().modified().unwrap();
        let read = |name: &str| fs::read_to_string(root.join(name)).unwrap();
        let bare_before = modified("Bare.md");
        let tasks_before = modified("Work/sub/Tasks.md");

        for (from, to) in [("Work", "Work/sub/Work"), ("Work", "Archive"), ("Work", ".trash/Work"), ("Work/Plan.md", "x")] {
            assert!(core.call("folder.rename", json!({ "from": from, "to": to })).is_err(), "{from} to {to}");
        }
        assert!(matches!(core.call("note.rename", json!({ "from": "Work", "to": "W" })), Err(Error::NotFound(_))));
        assert_eq!(read("Work/Plan.md"), "next: [[Tasks]] ![[pic.png]] ![[Work/pic.png]]\n");

        let result = core.call("folder.rename", json!({ "from": "Work", "to": "Archive/Work 2026" })).unwrap();
        assert_eq!(result, json!({ "updated": ["Home.md"] }));
        assert!(!root.join("Work").exists());
        assert_eq!(fs::read(root.join("Archive/Work 2026/pic.png")).unwrap(), [0u8, 159, 146, 150]);
        assert_eq!(read("Home.md"), "[[Plan]] [[Archive/Work 2026/Plan|the plan]] ![[sketch.excalidraw]] [[sub/Tasks]]\n");
        // Inside the folder only the image written with its path from the root had to change.
        assert_eq!(read("Archive/Work 2026/Plan.md"), "next: [[Tasks]] ![[pic.png]] ![[Archive/Work 2026/pic.png]]\n");
        assert_eq!(modified("Bare.md"), bare_before, "bare-name links still resolve, so the note is not written");
        assert_eq!(modified("Archive/Work 2026/sub/Tasks.md"), tasks_before);

        // The index follows the move.
        let resolved = core.call("note.resolve", json!({ "link": "sketch.excalidraw", "from": "Bare.md" })).unwrap();
        assert_eq!(resolved, json!({ "path": "Archive/Work 2026/sketch.excalidraw.md" }));
        assert_eq!(core.call("note.backlinks", json!({ "path": "Archive/Work 2026/Plan.md" })).unwrap().as_array().unwrap().len(), 3);

        // An image moved on its own, out of the folder of the note that shows it.
        let result = core.call("note.rename", json!({ "from": "Archive/Work 2026/pic.png", "to": "img/pic.png" })).unwrap();
        assert_eq!(result, json!({ "updated": ["Archive/Work 2026/Plan.md"] }));
        assert_eq!(read("Archive/Work 2026/Plan.md"), "next: [[Tasks]] ![[img/pic.png]] ![[img/pic.png]]\n");

        core.call("folder.new", json!({ "path": "Empty/Inside" })).unwrap();
        assert!(matches!(core.call("folder.new", json!({ "path": "Empty" })), Err(Error::Exists(_))));
        let trashed = core.call("folder.delete", json!({ "path": "Archive" })).unwrap();
        assert_eq!(trashed, json!({ "trashed": ".trash/Archive" }));
        assert_eq!(read(".trash/Archive/Work 2026/sub/Tasks.md"), "back: [[Plan]]\n");
        assert_eq!(core.call("note.resolve", json!({ "link": "Plan", "from": "Home.md" })).unwrap(), json!({ "path": null }));
        assert!(matches!(core.call("folder.delete", json!({ "path": "Home.md" })), Err(Error::NotFound(_))));
    }

    #[test]
    fn a_link_rewrite_that_fails_leaves_the_move_done_and_the_other_notes_rewritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("locked")).unwrap();
        fs::write(root.join("Old.md"), "").unwrap();
        fs::write(root.join("a.md"), "[[Old]]\n").unwrap();
        fs::write(root.join("locked/b.md"), "[[Old]]\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        // No new file can be made in this folder, so the note in it cannot be replaced.
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();

        let result = core.call("note.rename", json!({ "from": "Old.md", "to": "New.md" }));
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(result, Err(Error::Io(..))), "{result:?}");
        assert!(root.join("New.md").exists() && !root.join("Old.md").exists());
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "[[New]]\n");
        assert_eq!(fs::read_to_string(root.join("locked/b.md")).unwrap(), "[[Old]]\n");
    }

    #[test]
    fn delete_moves_the_note_to_the_trash_and_out_of_the_index() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Home.md"), "# Home\n").unwrap();
        fs::write(dir.path().join("a.md"), "go [[Home]]\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();

        let result = core.call("note.delete", json!({ "path": "a.md" })).unwrap();
        assert_eq!(result, json!({ "trashed": ".trash/a.md" }));
        assert_eq!(fs::read_to_string(dir.path().join(".trash/a.md")).unwrap(), "go [[Home]]\n");
        assert_eq!(core.call("vault.tree", Value::Null).unwrap(), json!([{ "name": "Home.md", "path": "Home.md" }]));
        // The trashed note no longer links to anything.
        assert_eq!(core.call("note.backlinks", json!({ "path": "Home.md" })).unwrap(), json!([]));
        assert!(matches!(core.call("note.delete", json!({ "path": "a.md" })), Err(Error::NotFound(_))));
    }

    #[test]
    fn config_files_are_written_and_listed() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        let empty = core.call("config.list", Value::Null).unwrap();
        assert_eq!(empty, json!({ "themes": [], "snippets": [] }));

        // `.inklode/` does not exist yet.
        core.call("config.write", json!({ "path": ".inklode/settings.json", "content": "{}" })).unwrap();
        let read = core.call("config.read", json!({ "path": ".inklode/settings.json" })).unwrap();
        assert_eq!(read, json!({ "content": "{}" }));

        for path in [".inklode/themes/night.css", ".inklode/themes/Day.css", ".inklode/themes/notes.txt", ".inklode/themes/sub/x.css"] {
            core.call("config.write", json!({ "path": path, "content": "" })).unwrap();
        }
        let listed = core.call("config.list", Value::Null).unwrap();
        assert_eq!(listed, json!({ "themes": ["Day", "night"], "snippets": [] }));
    }

    #[test]
    fn note_operations_refuse_dot_paths_and_config_operations_reach_only_inklode() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for folder in [".git/hooks", ".trash", ".obsidian", ".inklode", "Projects"] {
            fs::create_dir_all(root.join(folder)).unwrap();
        }
        let hidden = [".git/config", ".git/HEAD", ".trash/old.md", ".obsidian/app.json", ".inklode/settings.json", ".env"];
        for path in hidden.into_iter().chain(["a.md"]) {
            fs::write(root.join(path), path).unwrap();
        }
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        let refused = |result: Result<Value, Error>, what: &str| assert!(matches!(result, Err(Error::BadPath(_))), "{what}: {result:?}");

        for path in hidden.into_iter().chain(["Projects/.hidden/x.md"]) {
            refused(core.call("note.read", json!({ "path": path })), path);
            refused(core.call("note.write", json!({ "path": path, "content": "x" })), path);
            refused(core.call("note.create", json!({ "path": path })), path);
            refused(core.call("note.delete", json!({ "path": path })), path);
            refused(core.call("note.rename", json!({ "from": "a.md", "to": path })), path);
            refused(core.call("folder.new", json!({ "path": path })), path);
        }
        for path in hidden {
            refused(core.call("note.rename", json!({ "from": path, "to": "out.md" })), path);
        }
        refused(core.call("note.rename", json!({ "from": "a.md", "to": ".git/hooks/pre-commit" })), "a new file in .git");
        // The folder operations report a dot folder as a move that cannot be made, or as not there.
        assert!(matches!(core.call("folder.rename", json!({ "from": ".git", "to": "git" })), Err(Error::BadMove(..))));
        assert!(matches!(core.call("folder.rename", json!({ "from": "Projects", "to": ".git/p" })), Err(Error::BadMove(..))));
        assert!(matches!(core.call("folder.delete", json!({ "path": ".git" })), Err(Error::NotFound(_))));

        // Nothing moved and nothing was written.
        for path in hidden.into_iter().chain(["a.md"]) {
            assert_eq!(fs::read_to_string(root.join(path)).unwrap(), path);
        }
        for made in [".git/hooks/pre-commit", ".trash/.git", ".trash/.env", "out.md", "Projects/.hidden"] {
            assert!(!root.join(made).exists(), "{made}");
        }

        // The config operations reach the files in `.inklode/` and nothing else.
        core.call("config.write", json!({ "path": ".inklode/keys.json", "content": "{}" })).unwrap();
        assert_eq!(core.call("config.read", json!({ "path": ".inklode/settings.json" })).unwrap(), json!({ "content": ".inklode/settings.json" }));
        for path in [".git/config", "a.md", ".inklode/../a.md", ".inklode/.cache/x", ".inklode", ".inklodex/y", "sub/.inklode/x"] {
            refused(core.call("config.read", json!({ "path": path })), path);
            refused(core.call("config.write", json!({ "path": path, "content": "x" })), path);
        }
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "a.md");
    }

    // The next two tests need a disk that ignores case and Unicode normal form, as APFS does by default.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_from_spelled_another_way_than_on_disk_moves_and_rewrites_like_the_real_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("Proj")).unwrap();
        fs::write(root.join("Old.md"), "").unwrap();
        fs::write(root.join("Proj/p.md"), "").unwrap();
        // Stored decomposed: `a` and a combining breve.
        fs::write(root.join("Ma\u{306}r.md"), "").unwrap();
        fs::write(root.join("links.md"), "[[Old]] [[Proj/p]] [[Ma\u{306}r]]\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        let read = |name: &str| fs::read_to_string(root.join(name)).unwrap();
        let names = |folder: &str| {
            let mut names: Vec<String> = fs::read_dir(root.join(folder)).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            names.sort();
            names
        };

        let result = core.call("note.rename", json!({ "from": "old.md", "to": "New.md" })).unwrap();
        assert_eq!(result, json!({ "updated": ["links.md"] }));
        let result = core.call("folder.rename", json!({ "from": "proj", "to": "Work" })).unwrap();
        assert_eq!(result, json!({ "updated": ["links.md"] }));
        // Asked for composed, as a keyboard types it.
        let result = core.call("note.rename", json!({ "from": "M\u{103}r.md", "to": "Pear.md" })).unwrap();
        assert_eq!(result, json!({ "updated": ["links.md"] }));
        assert_eq!(read("links.md"), "[[New]] [[Work/p]] [[Pear]]\n");
        assert_eq!(names(""), ["New.md", "Pear.md", "Work", "links.md"]);
        assert!(matches!(core.call("note.rename", json!({ "from": "old.md", "to": "x.md" })), Err(Error::NotFound(_))));

        // A rename that only changes the case is still a rename, and no link needs to change for it.
        assert_eq!(core.call("note.rename", json!({ "from": "New.md", "to": "new.md" })).unwrap(), json!({ "updated": [] }));
        assert_eq!(core.call("folder.rename", json!({ "from": "Work", "to": "work" })).unwrap(), json!({ "updated": [] }));
        assert_eq!(names(""), ["Pear.md", "links.md", "new.md", "work"]);
        assert_eq!(read("links.md"), "[[New]] [[Work/p]] [[Pear]]\n");
        assert_eq!(core.call("note.resolve", json!({ "link": "New", "from": "links.md" })).unwrap(), json!({ "path": "new.md" }));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn create_counts_another_case_or_normal_form_of_a_name_as_taken() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("Home.md"), "keep").unwrap();
        // `ă` stored decomposed, `ț` stored composed.
        fs::write(root.join("Ma\u{306}r.md"), "keep").unwrap();
        fs::write(root.join("\u{21b}ara.md"), "keep").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        for path in ["home.md", "HOME.MD", "M\u{103}r.md", "t\u{326}ara.md"] {
            let result = core.call("note.create", json!({ "path": path, "content": "new" }));
            assert!(matches!(result, Err(Error::Exists(_))), "{path}: {result:?}");
            assert_eq!(fs::read_to_string(root.join(path)).unwrap(), "keep");
        }
        assert_eq!(fs::read_dir(root).unwrap().count(), 3);
    }

    #[test]
    fn attachment_read_gives_the_bytes_and_refuses_dot_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Bytes that are not UTF-8, which `note.read` refuses.
        fs::write(root.join("doc.pdf"), [b'%', b'P', b'D', b'F', 0xff, 0x00]).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/x.pdf"), "secret").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();

        assert!(core.call("note.read", json!({ "path": "doc.pdf" })).is_err());
        let read = core.call("attachment.read", json!({ "path": "doc.pdf" })).unwrap();
        assert_eq!(BASE64.decode(read["data"].as_str().unwrap()).unwrap(), [b'%', b'P', b'D', b'F', 0xff, 0x00]);
        assert!(matches!(core.call("attachment.read", json!({ "path": ".git/x.pdf" })), Err(Error::BadPath(_))));
        assert!(core.call("attachment.read", json!({ "path": "missing.pdf" })).is_err());
    }

    #[test]
    fn attachment_create_writes_the_bytes_and_never_replaces_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.png"), "keep").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();

        // "iVBORw0KGgo=" is the PNG signature, bytes that are not UTF-8.
        let png = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        core.call("attachment.create", json!({ "path": "img/Pasted image.png", "data": "iVBORw0KGgo=" })).unwrap();
        assert_eq!(fs::read(root.join("img/Pasted image.png")).unwrap(), png);

        assert!(matches!(core.call("attachment.create", json!({ "path": "a.png", "data": "iVBORw0KGgo=" })), Err(Error::Exists(_))));
        assert_eq!(fs::read_to_string(root.join("a.png")).unwrap(), "keep");
        assert!(matches!(core.call("attachment.create", json!({ "path": "b.png", "data": "not base64!" })), Err(Error::BadParams(..))));
        assert!(!root.join("b.png").exists());
        assert!(matches!(core.call("attachment.create", json!({ "path": ".git/x.png", "data": "" })), Err(Error::BadPath(_))));
    }

    #[test]
    fn create_makes_a_new_file_and_never_replaces_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "keep").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();

        for params in [json!({ "path": "a.md" }), json!({ "path": "a.md", "content": "x" })] {
            assert!(matches!(core.call("note.create", params), Err(Error::Exists(_))));
        }
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "keep");

        assert_eq!(core.call("note.create", json!({ "path": "new/deep/b.md" })).unwrap(), Value::Null);
        assert_eq!(fs::read_to_string(root.join("new/deep/b.md")).unwrap(), "");
        core.call("note.create", json!({ "path": "c.md", "content": "a zebra\n" })).unwrap();
        assert_eq!(fs::read_to_string(root.join("c.md")).unwrap(), "a zebra\n");
        // A folder has the name too.
        assert!(matches!(core.call("note.create", json!({ "path": "new/deep" })), Err(Error::Exists(_))));
        assert!(matches!(core.call("note.create", json!({ "path": "../x.md" })), Err(Error::BadPath(_))));
        // The index follows.
        let found = core.call("search", json!({ "query": "zebra" })).unwrap();
        assert_eq!(found, json!([{ "path": "c.md", "line": 1, "text": "a zebra" }]));
    }

    #[test]
    fn a_write_with_a_base_fails_when_the_file_no_longer_has_that_text() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "one").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        let read = |name: &str| fs::read_to_string(root.join(name)).unwrap();
        let write = |core: &mut Core, path: &str, content: &str, base: &str| core.call("note.write", json!({ "path": path, "content": content, "base": base }));

        write(&mut core, "a.md", "two", "one").unwrap();
        assert_eq!(read("a.md"), "two");

        // Another program writes the file. Also a change of one newline is a change.
        for outside in ["outside", "two\n"] {
            fs::write(root.join("a.md"), outside).unwrap();
            let result = write(&mut core, "a.md", "three", "two");
            assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
            assert_eq!(result.unwrap_err().to_string(), "changed on disk since it was read: a.md");
            assert_eq!(read("a.md"), outside);
        }
        // A file that is gone conflicts with any text it had; a new file's base is the empty text.
        assert!(matches!(write(&mut core, "new/b.md", "x", "was here"), Err(Error::Conflict(_))));
        assert!(!root.join("new").exists());
        write(&mut core, "new/b.md", "x", "").unwrap();
        assert_eq!(read("new/b.md"), "x");
        // No temporary file is left behind by a refused write.
        assert_eq!(fs::read_dir(root).unwrap().count(), 2);

        // Without a base the write replaces whatever is there.
        core.call("note.write", json!({ "path": "a.md", "content": "four" })).unwrap();
        assert_eq!(read("a.md"), "four");
    }

    #[test]
    fn a_move_to_a_name_that_links_already_use_keeps_those_links_on_their_note() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("Other.md"), "").unwrap();
        fs::write(root.join("Old.md"), "").unwrap();
        fs::write(root.join("sub/n.md"), "[[Other]] [[Other#H|x]]\n").unwrap();
        fs::write(root.join("sub/quiet.md"), "[[n]] and Other\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        let modified = |name: &str| fs::metadata(root.join(name)).unwrap().modified().unwrap();
        let read = |name: &str| fs::read_to_string(root.join(name)).unwrap();
        let resolve = |core: &mut Core, link: &str, from: &str| core.call("note.resolve", json!({ "link": link, "from": from })).unwrap()["path"].clone();
        let quiet_before = modified("sub/quiet.md");

        // The moved note would arrive next to `n.md` under the name its links use for the
        // note at the root. No link Obsidian reads says "the one at the root" from there,
        // so the move is refused and nothing changes.
        let result = core.call("note.rename", json!({ "from": "Old.md", "to": "sub/Other.md" }));
        assert!(matches!(result, Err(Error::LinkLost(..))), "{result:?}");
        assert!(root.join("Old.md").exists() && !root.join("sub/Other.md").exists());
        assert_eq!(read("sub/n.md"), "[[Other]] [[Other#H|x]]\n");
        assert_eq!(resolve(&mut core, "Other", "sub/n.md"), "Other.md");
        assert_eq!(modified("sub/quiet.md"), quiet_before, "a note whose links did not change must not be written");

        // A folder that moves to where its note becomes the nearest of that name.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("x/y")).unwrap();
        fs::create_dir_all(root.join("a long folder")).unwrap();
        fs::write(root.join("x/y/Other.md"), "").unwrap();
        fs::write(root.join("a long folder/Other.md"), "").unwrap();
        fs::write(root.join("n.md"), "[[Other]]\n").unwrap();
        fs::write(root.join("quiet.md"), "[[n]]\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": root })).unwrap();
        let quiet_before = fs::metadata(root.join("quiet.md")).unwrap().modified().unwrap();
        let result = core.call("folder.rename", json!({ "from": "a long folder", "to": "z" })).unwrap();
        assert_eq!(result, json!({ "updated": ["n.md"] }));
        assert_eq!(fs::read_to_string(root.join("n.md")).unwrap(), "[[x/y/Other]]\n");
        assert_eq!(fs::metadata(root.join("quiet.md")).unwrap().modified().unwrap(), quiet_before);
    }

    /// Runs git in `dir` as `author`, apart from the config of the machine the test runs on.
    fn git_as(dir: &std::path::Path, author: &str, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", author)
            .env("GIT_AUTHOR_EMAIL", "author@example.com")
            .env("GIT_COMMITTER_NAME", author)
            .env("GIT_COMMITTER_EMAIL", "author@example.com")
            .env("GIT_AUTHOR_DATE", "2026-03-01T10:00:00+02:00")
            .env("GIT_COMMITTER_DATE", "2026-03-01T10:00:00+02:00")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap()
    }

    #[test]
    fn git_history_is_read_through_a_rename_and_nothing_is_written() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        // The vault is the repository's root, then a folder inside a repository.
        for sub in ["", "notes"] {
            let dir = tempfile::tempdir().unwrap();
            let vault = dir.path().join(sub);
            fs::create_dir_all(&vault).unwrap();
            git_as(dir.path(), "Ana", &["init", "-q"]);
            let commit = |author: &str, subject: &str| {
                git_as(&vault, author, &["add", "-A"]);
                git_as(&vault, author, &["commit", "-q", "-m", subject]);
                git_as(&vault, author, &["rev-parse", "HEAD"]).trim().to_string()
            };
            fs::write(vault.join("Old.md"), "one\ntwo\nthree\nfour\n").unwrap();
            let first = commit("Ana", "first");
            fs::write(vault.join("Old.md"), "one\nTWO\nthree\nfour\n").unwrap();
            let second = commit("Bob", "second line");
            git_as(&vault, "Ana", &["mv", "Old.md", "New.md"]);
            let renamed = commit("Ana", "rename");
            fs::write(vault.join("New.md"), "one\nTWO\nthree\nfour\nfive\n").unwrap();
            let last = commit("Bob", "a fifth line");
            // Not committed: a change to the note and a new note.
            fs::write(vault.join("New.md"), "one\nTWO\nthree\nfour\nfive\nsix\n").unwrap();
            fs::write(vault.join("Draft.md"), "draft\n").unwrap();
            let status = git_as(&vault, "Ana", &["status", "--porcelain"]);

            let mut core = Core::new();
            core.call("vault.open", json!({ "path": vault })).unwrap();
            let entry = |rev: &str, author: &str, subject: &str| json!({ "rev": rev, "author": author, "date": "2026-03-01T10:00:00+02:00", "subject": subject });

            let log = core.call("git.log", json!({ "path": "New.md" })).unwrap();
            assert_eq!(
                log,
                json!([entry(&last, "Bob", "a fifth line"), entry(&renamed, "Ana", "rename"), entry(&second, "Bob", "second line"), entry(&first, "Ana", "first")]),
                "vault at {sub:?}"
            );

            let show = |core: &mut Core, params: Value| core.call("git.show", params).unwrap()["content"].clone();
            // From before the rename, under the name the file had then, also by a short hash.
            assert_eq!(show(&mut core, json!({ "path": "New.md", "rev": first })), "one\ntwo\nthree\nfour\n");
            assert_eq!(show(&mut core, json!({ "path": "New.md", "rev": &second[..8] })), "one\nTWO\nthree\nfour\n");
            assert_eq!(show(&mut core, json!({ "path": "New.md", "rev": last })), "one\nTWO\nthree\nfour\nfive\n");
            // Without a rev: the last commit, not the file on disk.
            assert_eq!(show(&mut core, json!({ "path": "New.md" })), "one\nTWO\nthree\nfour\nfive\n");
            assert_eq!(show(&mut core, json!({ "path": "New.md", "rev": "0123456789abcdef" })), Value::Null);

            let blame = core.call("git.blame", json!({ "path": "New.md" })).unwrap();
            let range = |from: usize, to: usize, mut commit: Value| {
                commit["from"] = json!(from);
                commit["to"] = json!(to);
                commit
            };
            assert_eq!(
                blame,
                json!([
                    range(1, 1, entry(&first, "Ana", "first")),
                    range(2, 2, entry(&second, "Bob", "second line")),
                    range(3, 4, entry(&first, "Ana", "first")),
                    range(5, 5, entry(&last, "Bob", "a fifth line")),
                ])
            );

            // A file git does not know.
            for path in ["Draft.md", "nope.md"] {
                assert_eq!(core.call("git.log", json!({ "path": path })).unwrap(), json!([]));
                assert_eq!(core.call("git.blame", json!({ "path": path })).unwrap(), json!([]));
                assert_eq!(show(&mut core, json!({ "path": path })), Value::Null);
            }

            // Only a hash is passed to git as a revision, and only a note's path as a path.
            for rev in ["HEAD", "HEAD~1", "main", "--output=x", "abc", "ABCDEF12", ""] {
                let result = core.call("git.show", json!({ "path": "New.md", "rev": rev }));
                assert!(matches!(result, Err(Error::BadParams(..))), "{rev}: {result:?}");
            }
            for path in [".git/config", "../New.md", "/etc/hosts", ".inklode/settings.json"] {
                for name in ["git.log", "git.show", "git.blame"] {
                    let result = core.call(name, json!({ "path": path }));
                    assert!(matches!(result, Err(Error::BadPath(_))), "{name} {path}: {result:?}");
                }
            }

            // Reading left the repository and the files as they were.
            assert_eq!(git_as(&vault, "Ana", &["status", "--porcelain"]), status);
            assert_eq!(git_as(&vault, "Ana", &["rev-parse", "HEAD"]).trim(), last);
            assert_eq!(fs::read_to_string(vault.join("New.md")).unwrap(), "one\nTWO\nthree\nfour\nfive\nsix\n");
        }
    }

    #[test]
    fn health_lists_broken_links_notes_without_links_and_notes_older_than_their_repos() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        // A repository with a commit at noon on 2026-03-01, local time, and one more on a branch that is not checked out.
        let code = tempfile::tempdir().unwrap();
        let repo = code.path().join("app");
        fs::create_dir(&repo).unwrap();
        fs::write(repo.join("main.rs"), "fn main() {}\n").unwrap();
        let git_at = |args: &[&str]| {
            let config = ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "user.name=Ana", "-c", "user.email=ana@example.com"];
            let dates = [("GIT_AUTHOR_DATE", "2026-03-01T12:00:00"), ("GIT_COMMITTER_DATE", "2026-03-01T12:00:00")];
            let output = std::process::Command::new("git").current_dir(&repo).args(config).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").envs(dates).output().unwrap();
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8(output.stdout).unwrap()
        };
        git_at(&["init", "-q"]);
        git_at(&["add", "-A"]);
        git_at(&["commit", "-q", "-m", "first"]);
        fs::write(repo.join("main.rs"), "fn main() { run() }\n").unwrap();
        git_at(&["checkout", "-q", "-b", "feature"]);
        git_at(&["commit", "-q", "-am", "run it"]);
        git_at(&["checkout", "-q", "main"]);
        let refs = git_at(&["for-each-ref"]);
        let short = git_at(&["rev-parse", "--short", "main"]).trim().to_string();
        let path = repo.to_str().unwrap();

        let dir = tempfile::tempdir().unwrap();
        let note = |updated: &str| format!("---\nrepos: [\"{path}\"]\nupdated: {updated}\n---\nSee [[Hub]].\n");
        let notes = [
            ("Hub.md", "[[Old]] [[Same day]] [[Later]] [[No date]] [[No repo]] [[Linked#Part|part]] ![[img.png]] [[#Top]]\n".to_string()),
            ("Old.md", note("2026-02-28")),
            ("Same day.md", note("2026-03-01")),
            ("Later.md", note("2026-03-02")),
            ("No date.md", note("soon")),
            ("No repo.md", "---\nrepos: [no-such-repo-anywhere, /no/such/folder]\nupdated: 2026-02-28\n---\n[[Hub]]\n".to_string()),
            ("Linked.md", "text\n".to_string()),
            ("Alone.md", "No link here, and `[[code]]` is not one.\n".to_string()),
            ("sub/Broken.md", "one\nSee [[Missing]] and [[Hub]].\n```\n[[fenced]]\n```\n![[lost.png]] [[Missing#Part|alias]]\n".to_string()),
            // A template has a broken link, no link from a note, `repos:` and no date, and is in no list.
            ("sub/_templates/Task.md", "---\nrepos: [no-such-repo-anywhere]\nupdated:\n---\n[[Placeholder]]\n".to_string()),
        ];
        fs::create_dir_all(dir.path().join("sub/_templates")).unwrap();
        fs::write(dir.path().join("img.png"), [0u8]).unwrap();
        for (name, text) in &notes {
            fs::write(dir.path().join(name), text).unwrap();
        }
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        let health = core.call("vault.health", Value::Null).unwrap();

        assert_eq!(
            health["broken"],
            json!([{ "path": "sub/Broken.md", "links": [
                { "line": 2, "link": "Missing", "text": "See [[Missing]] and [[Hub]]." },
                { "line": 6, "link": "lost.png", "text": "![[lost.png]] [[Missing#Part|alias]]" },
                { "line": 6, "link": "Missing#Part|alias", "text": "![[lost.png]] [[Missing#Part|alias]]" },
            ] }])
        );
        assert_eq!(health["orphans"], json!(["Alone.md"]));
        // Only the note updated before the day of the commit: the day itself does not count.
        // The commit on the branch that is not checked out does not count either.
        let dir_found = fs::canonicalize(&repo).unwrap();
        assert_eq!(health["stale"].as_array().unwrap().len(), 1, "{}", health["stale"]);
        let stale = &health["stale"][0];
        assert_eq!((&stale["path"], &stale["updated"], &stale["repo"], &stale["commits"]), (&json!("Old.md"), &json!("2026-02-28"), &json!(path), &json!(1)));
        assert_eq!(fs::canonicalize(stale["dir"].as_str().unwrap()).unwrap(), dir_found);
        assert_eq!(stale["newest"], json!({ "date": "2026-03-01", "rev": short, "subject": "first" }));
        assert_eq!(
            health["unchecked"],
            json!([
                { "path": "No date.md", "repo": null, "reason": "no valid `updated:` date" },
                { "path": "No repo.md", "repo": "no-such-repo-anywhere", "reason": "not found or not a git repository" },
                { "path": "No repo.md", "repo": "/no/such/folder", "reason": "not found or not a git repository" },
            ])
        );
        // The report was taken out of the core before git ran: it is of the notes as they were
        // then, and the core is free to work meanwhile.
        let check = core.health_check().unwrap();
        core.call("note.write", json!({ "path": "Old.md", "content": "No repos any more, see [[Hub]].\n" })).unwrap();
        assert_eq!(json!(check.run())["stale"], health["stale"]);
        assert_eq!(core.call("vault.health", Value::Null).unwrap()["stale"], json!([]));

        // Reading left the repository as it was.
        assert_eq!(git_at(&["for-each-ref"]), refs);
        assert_eq!(git_at(&["status", "--porcelain"]), "");
        assert!(!repo.join(".git/FETCH_HEAD").exists());
    }

    #[test]
    fn tasks_lists_the_open_checkboxes_outside_code_fences() {
        let dir = tempfile::tempdir().unwrap();
        let text = "# Plan\n- [ ] first\n- [x] done\n  * [ ] nested *star*\n+ [ ] plus\n1. [ ] numbered\n2) [ ]   spaced  \n- [ ]\n```\n- [ ] in a fence\n```\n~~~sh\n- [ ] in a tilde fence\n~~~\n-[ ] no space\n- [] no gap\n- [ ]tight\ntext - [ ] not an item\n- [X] done too\n";
        fs::write(dir.path().join("Plan.md"), text).unwrap();
        fs::write(dir.path().join("Done.md"), "- [x] all done\n").unwrap();
        fs::write(dir.path().join("Also.md"), "\n\n> quoted\n\n- [ ] one more\n").unwrap();
        // A template's empty checkboxes are not tasks.
        fs::create_dir(dir.path().join("_templates")).unwrap();
        fs::write(dir.path().join("_templates/Task.md"), "- [ ] step\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        let task = |line: usize, text: &str| json!({ "line": line, "text": text });
        assert_eq!(
            core.call("vault.tasks", Value::Null).unwrap(),
            json!([
                { "path": "Also.md", "tasks": [task(5, "one more")] },
                { "path": "Plan.md", "tasks": [task(2, "first"), task(4, "nested *star*"), task(5, "plus"), task(6, "numbered"), task(7, "spaced"), task(8, "")] },
            ])
        );
        // A ticked box is off the list at the next call.
        fs::write(dir.path().join("Also.md"), "\n\n> quoted\n\n- [x] one more\n").unwrap();
        core.call("note.write", json!({ "path": "Plan.md", "content": "- [ ] only\n" })).unwrap();
        assert_eq!(core.call("vault.tasks", Value::Null).unwrap()[0], json!({ "path": "Plan.md", "tasks": [task(1, "only")] }));
    }

    #[test]
    fn git_operations_on_a_vault_without_a_repository_give_nothing() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "one\n").unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        assert_eq!(core.call("git.log", json!({ "path": "a.md" })).unwrap(), json!([]));
        assert_eq!(core.call("git.blame", json!({ "path": "a.md" })).unwrap(), json!([]));
        assert_eq!(core.call("git.show", json!({ "path": "a.md" })).unwrap(), json!({ "content": null }));
        assert_eq!(core.call("git.show", json!({ "path": "a.md", "rev": "0123abcd" })).unwrap(), json!({ "content": null }));
        assert!(!dir.path().join(".git").exists());
    }

    #[test]
    fn review_lists_the_notes_changed_since_the_user_last_looked() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        // The vault is the repository's root, then a folder inside a repository.
        for sub in ["", "notes"] {
            let dir = tempfile::tempdir().unwrap();
            let state = tempfile::tempdir().unwrap();
            let vault = dir.path().join(sub);
            fs::create_dir_all(vault.join(".obsidian")).unwrap();
            git_as(dir.path(), "Ana", &["init", "-q"]);
            let commit = |author: &str, subject: &str| {
                git_as(&vault, author, &["add", "-A"]);
                git_as(&vault, author, &["commit", "-q", "-m", subject]);
                git_as(&vault, author, &["rev-parse", "HEAD"]).trim().to_string()
            };
            let write = |name: &str, text: &str| fs::write(vault.join(name), text).unwrap();
            for name in ["a.md", "b.md", "gone.md", "mine.md", "quiet.md"] {
                write(name, "one\ntwo\n");
            }
            write("data.txt", "one\n");
            commit("Ana", "first");
            // Not committed when review is first used: these do not wait either.
            write("b.md", "one\ntwo\nthree\n");
            write("draft.md", "draft\n");

            // A new core each time: what was seen is in the state folder, not in the core.
            let open = || {
                let mut core = Core::new();
                core.set_state_dir(state.path());
                core.call("vault.open", json!({ "path": vault })).unwrap();
                core
            };
            let list = |core: &mut Core| core.call("review.list", Value::Null).unwrap();
            let paths = |core: &mut Core| -> Vec<String> {
                list(core)["entries"].as_array().unwrap().iter().map(|entry| entry["path"].as_str().unwrap().to_string()).collect()
            };
            let mut core = open();
            assert_eq!(list(&mut core), json!({ "repository": true, "entries": [] }), "vault at {sub:?}");

            // Another author commits a change, and more is left uncommitted.
            write("a.md", "one\nTWO\nthree\n");
            let second = commit("Bob", "agent edit");
            write("b.md", "one\ntwo\nthree\nfour\n");
            write("new.md", "new\nnote\n");
            write("empty.md", "");
            write("data.txt", "two\n");
            write(".obsidian/x.md", "hidden\n");
            fs::remove_file(vault.join("gone.md")).unwrap();
            // A new time and the same text is not a change.
            write("quiet.md", "one\ntwo\n");

            let entry = |path: &str, status: &str, added: usize, removed: usize, commits: Value, uncommitted: bool| {
                json!({ "path": path, "status": status, "added": added, "removed": removed, "commits": commits, "uncommitted": uncommitted })
            };
            let by_bob = json!([{ "rev": second, "author": "Bob", "date": "2026-03-01T10:00:00+02:00", "subject": "agent edit" }]);
            // b.md was committed by Bob as it was accepted at first use, then changed again: one line more than accepted.
            assert_eq!(
                list(&mut core)["entries"],
                json!([
                    entry("a.md", "changed", 2, 1, by_bob.clone(), false),
                    entry("b.md", "changed", 1, 0, by_bob.clone(), true),
                    entry("gone.md", "deleted", 0, 2, json!([]), true),
                    entry("new.md", "added", 2, 0, json!([]), true),
                ])
            );
            let base = |core: &mut Core, path: &str| core.call("review.base", json!({ "path": path })).unwrap()["content"].clone();
            assert_eq!(base(&mut core, "a.md"), "one\ntwo\n");
            assert_eq!(base(&mut core, "gone.md"), "one\ntwo\n");
            assert_eq!(base(&mut core, "new.md"), Value::Null);

            // Accepting one note takes it out, for a new core too, until its text changes again.
            core.call("review.accept", json!({ "path": "a.md" })).unwrap();
            core.call("review.accept", json!({ "path": "gone.md" })).unwrap();
            assert_eq!(paths(&mut core), ["b.md", "new.md"]);
            let mut core = open();
            assert_eq!(paths(&mut core), ["b.md", "new.md"]);
            write("a.md", "one\nTWO\nthree\nfour\n");
            assert_eq!(paths(&mut core), ["a.md", "b.md", "new.md"]);
            // Back at the text of `base`, a note that was accepted with another text waits: it is not what was seen.
            write("b.md", "one\ntwo\n");
            assert_eq!(paths(&mut core), ["a.md", "b.md", "new.md"]);

            // The user's own edit of a note that was not waiting does not wait. Of one that was, it still does.
            let saved = |core: &mut Core, path: &str, before: &str, after: &str| {
                write(path, after);
                core.call("review.saved", json!({ "path": path, "before": before, "after": after })).unwrap();
            };
            saved(&mut core, "mine.md", "one\ntwo\n", "one\ntwo\nmine\n");
            saved(&mut core, "mine.md", "one\ntwo\nmine\n", "one\ntwo\nmine too\n");
            saved(&mut core, "typed.md", "", "typed here\n");
            saved(&mut core, "new.md", "new\nnote\n", "new\nnote\nand mine\n");
            assert_eq!(paths(&mut core), ["a.md", "b.md", "new.md"]);
            // Changed by someone else after that, it waits.
            write("mine.md", "one\ntwo\nmine too\nand theirs\n");
            assert_eq!(paths(&mut core), ["a.md", "b.md", "mine.md", "new.md"]);

            // Accepting everything empties the inbox, for a new core too, and the next commit shows alone.
            core.call("review.accept", json!({})).unwrap();
            assert_eq!(paths(&mut core), [] as [&str; 0]);
            let mut core = open();
            assert_eq!(list(&mut core), json!({ "repository": true, "entries": [] }));
            write("a.md", "last\n");
            fs::remove_file(vault.join("new.md")).unwrap();
            let third = commit("Bob", "agent again");
            let by_bob = json!([{ "rev": third, "author": "Bob", "date": "2026-03-01T10:00:00+02:00", "subject": "agent again" }]);
            // Both against the texts accepted with everything, which were not committed then.
            assert_eq!(
                list(&mut core)["entries"],
                json!([entry("a.md", "changed", 1, 4, by_bob, false), entry("new.md", "deleted", 0, 3, json!([]), false)])
            );

            // Only a note's path goes to git, and nothing works without a state folder.
            for path in [".git/config", "../a.md", ".inklode/settings.json"] {
                for (name, params) in [("review.base", json!({ "path": path })), ("review.accept", json!({ "path": path }))] {
                    let result = core.call(name, params);
                    assert!(matches!(result, Err(Error::BadPath(_))), "{name} {path}: {result:?}");
                }
            }
            let mut bare = Core::new();
            bare.call("vault.open", json!({ "path": vault })).unwrap();
            assert!(matches!(bare.call("review.list", Value::Null), Err(Error::NoStateFolder)));

            // The state is one file, outside the vault.
            assert_eq!(fs::read_dir(state.path().join("review")).unwrap().count(), 1);
            assert_eq!(git_as(&vault, "Ana", &["status", "--porcelain"]), "");
            assert_eq!(git_as(&vault, "Ana", &["rev-parse", "HEAD"]).trim(), third);
        }
    }

    /// A vault that is a git repository with `notes` committed, a state folder, and a core on both that has used review.
    fn review_vault(notes: &[(&str, &str)]) -> (tempfile::TempDir, tempfile::TempDir, Core) {
        let (dir, state) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        git_as(dir.path(), "Ana", &["init", "-q"]);
        for (path, text) in notes {
            fs::create_dir_all(dir.path().join(path).parent().unwrap()).unwrap();
            fs::write(dir.path().join(path), text).unwrap();
        }
        git_as(dir.path(), "Ana", &["add", "-A"]);
        git_as(dir.path(), "Ana", &["commit", "-q", "-m", "first"]);
        let mut core = Core::new();
        core.set_state_dir(state.path());
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        assert_eq!(core.call("review.list", Value::Null).unwrap(), json!({ "repository": true, "entries": [] }));
        (dir, state, core)
    }

    /// What waits, as `path status +added -removed`.
    fn waiting(core: &mut Core) -> Vec<String> {
        let list = core.call("review.list", Value::Null).unwrap();
        let line = |e: &Value| format!("{} {} +{} -{}", e["path"].as_str().unwrap(), e["status"].as_str().unwrap(), e["added"], e["removed"]);
        list["entries"].as_array().unwrap().iter().map(line).collect()
    }

    /// The one state file review keeps for the vault.
    fn review_state(state: &tempfile::TempDir) -> std::path::PathBuf {
        fs::read_dir(state.path().join("review")).unwrap().next().unwrap().unwrap().path()
    }

    #[test]
    fn review_compares_a_note_with_the_text_last_accepted() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let (dir, state, mut core) = review_vault(&[("a.md", "one\ntwo\n"), ("gone.md", "one\ntwo\n"), ("mine.md", "one\n")]);
        let write = |name: &str, text: &str| fs::write(dir.path().join(name), text).unwrap();
        let base = |core: &mut Core, path: &str| core.call("review.base", json!({ "path": path })).unwrap()["content"].clone();
        let accept = |core: &mut Core, path: &str| core.call("review.accept", json!({ "path": path })).unwrap();
        let none: [&str; 0] = [];

        // Accepted, then changed again from outside: only the second change shows.
        write("a.md", "one\nTWO\n");
        assert_eq!(waiting(&mut core), ["a.md changed +1 -1"]);
        accept(&mut core, "a.md");
        assert_eq!(waiting(&mut core), none);
        write("a.md", "one\nTWO\nthree\n");
        assert_eq!(waiting(&mut core), ["a.md changed +1 -0"]);
        assert_eq!(base(&mut core, "a.md"), "one\nTWO\n");
        // Taken back to the commit's text from outside, it is still not what was accepted.
        write("a.md", "one\ntwo\n");
        assert_eq!(waiting(&mut core), ["a.md changed +1 -1"]);
        assert_eq!(base(&mut core, "a.md"), "one\nTWO\n");
        write("a.md", "one\nTWO\n");
        assert_eq!(waiting(&mut core), none);

        // An accepted deletion: the note made again is a new one, with no earlier text.
        fs::remove_file(dir.path().join("gone.md")).unwrap();
        assert_eq!(waiting(&mut core), ["gone.md deleted +0 -2"]);
        assert_eq!(base(&mut core, "gone.md"), "one\ntwo\n");
        accept(&mut core, "gone.md");
        assert_eq!(waiting(&mut core), none);
        assert_eq!(base(&mut core, "gone.md"), Value::Null);
        write("gone.md", "back\n");
        assert_eq!(waiting(&mut core), ["gone.md added +1 -0"]);
        // And an accepted text that is deleted shows that text as what is gone.
        accept(&mut core, "gone.md");
        fs::remove_file(dir.path().join("gone.md")).unwrap();
        assert_eq!(waiting(&mut core), ["gone.md deleted +0 -1"]);
        assert_eq!(base(&mut core, "gone.md"), "back\n");
        accept(&mut core, "gone.md");

        // An accepted new note.
        write("new.md", "new\n");
        assert_eq!(waiting(&mut core), ["new.md added +1 -0"]);
        accept(&mut core, "new.md");
        write("new.md", "new\nmore\n");
        assert_eq!(waiting(&mut core), ["new.md changed +1 -0"]);
        assert_eq!(base(&mut core, "new.md"), "new\n");
        accept(&mut core, "new.md");

        // The user's own save is accepted with its text.
        write("mine.md", "one\nmine\n");
        core.call("review.saved", json!({ "path": "mine.md", "before": "one\n", "after": "one\nmine\n" })).unwrap();
        assert_eq!(waiting(&mut core), none);
        write("mine.md", "one\nmine\ntheirs\n");
        assert_eq!(base(&mut core, "mine.md"), "one\nmine\n");

        // A new core reads the same from the state folder.
        let mut core = Core::new();
        core.set_state_dir(state.path());
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        assert_eq!(waiting(&mut core), ["mine.md changed +1 -0"]);
        assert_eq!(base(&mut core, "a.md"), "one\nTWO\n");

        // Accepting everything with all of it committed keeps no text.
        git_as(dir.path(), "Bob", &["add", "-A"]);
        git_as(dir.path(), "Bob", &["commit", "-q", "-m", "second"]);
        core.call("review.accept", json!({})).unwrap();
        let kept: Value = serde_json::from_slice(&fs::read(review_state(&state)).unwrap()).unwrap();
        assert_eq!(kept["accepted"], json!({}));
        assert_eq!(waiting(&mut core), none);
        assert_eq!(base(&mut core, "a.md"), "one\nTWO\n");
    }

    #[test]
    fn review_reads_a_state_that_has_only_a_digest_of_an_accepted_text() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let (dir, state, mut core) = review_vault(&[("a.md", "one\ntwo\n")]);
        let write = |text: &str| fs::write(dir.path().join("a.md"), text).unwrap();
        // The state as it was written before the texts were kept.
        write("one\nTWO\n");
        let file = review_state(&state);
        let mut kept: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        kept["accepted"] = json!({ "a.md": review::digest(b"one\nTWO\n") });
        fs::write(&file, kept.to_string()).unwrap();

        // Accepted all the same, and compared with the commit when it changes again.
        assert_eq!(waiting(&mut core), [] as [&str; 0]);
        assert_eq!(core.call("review.base", json!({ "path": "a.md" })).unwrap(), json!({ "content": "one\ntwo\n" }));
        write("one\nTWO\nthree\n");
        assert_eq!(waiting(&mut core), ["a.md changed +2 -1"]);
        // The next accept keeps the text.
        core.call("review.accept", json!({ "path": "a.md" })).unwrap();
        write("one\nTWO\nthree\nfour\n");
        assert_eq!(waiting(&mut core), ["a.md changed +1 -0"]);
        assert_eq!(core.call("review.base", json!({ "path": "a.md" })).unwrap(), json!({ "content": "one\nTWO\nthree\n" }));
    }

    #[test]
    fn what_the_user_does_in_the_app_does_not_wait_for_review() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let notes = [("target.md", "target\n"), ("linker.md", "see [[target]]\n"), ("busy.md", "old [[target]]\n"), ("dir/x.md", "x\n"), ("dir/y.md", "y\n")];
        let none: [&str; 0] = [];

        // A rename by someone else: the note that moved and the notes whose links were rewritten all wait.
        let (_dir, _state, mut core) = review_vault(&notes);
        core.call("note.rename", json!({ "from": "target.md", "to": "renamed.md" })).unwrap();
        assert_eq!(waiting(&mut core), ["busy.md changed +1 -1", "linker.md changed +1 -1", "renamed.md added +1 -0", "target.md deleted +0 -1"]);

        // The user's own: nothing waits, and what the notes are now is what they are compared with.
        let (dir, _state, mut core) = review_vault(&notes);
        core.call("note.rename", json!({ "from": "target.md", "to": "renamed.md", "own": true })).unwrap();
        assert_eq!(waiting(&mut core), none);
        assert_eq!(fs::read_to_string(dir.path().join("linker.md")).unwrap(), "see [[renamed]]\n");
        fs::write(dir.path().join("linker.md"), "see [[renamed]]\nmore\n").unwrap();
        assert_eq!(waiting(&mut core), ["linker.md changed +1 -0"]);
        assert_eq!(core.call("review.base", json!({ "path": "linker.md" })).unwrap(), json!({ "content": "see [[renamed]]\n" }));

        // A note that was waiting stays, with the rewritten link in it, and so does a waiting note that moves.
        let (dir, _state, mut core) = review_vault(&notes);
        fs::write(dir.path().join("busy.md"), "new [[target]]\n").unwrap();
        core.call("note.rename", json!({ "from": "target.md", "to": "renamed.md", "own": true })).unwrap();
        assert_eq!(waiting(&mut core), ["busy.md changed +1 -1"]);
        assert_eq!(fs::read_to_string(dir.path().join("busy.md")).unwrap(), "new [[renamed]]\n");
        core.call("note.rename", json!({ "from": "busy.md", "to": "busier.md", "own": true })).unwrap();
        assert_eq!(waiting(&mut core), ["busier.md added +1 -0", "busy.md deleted +0 -1"]);

        // Deletes, a folder that moves, and a new note.
        let (dir, _state, mut core) = review_vault(&notes);
        core.call("note.delete", json!({ "path": "target.md", "own": true })).unwrap();
        core.call("folder.rename", json!({ "from": "dir", "to": "moved", "own": true })).unwrap();
        core.call("folder.delete", json!({ "path": "moved", "own": true })).unwrap();
        core.call("note.create", json!({ "path": "made.md", "content": "made\n", "own": true })).unwrap();
        assert_eq!(waiting(&mut core), none);
        // A note that waited as deleted and is made again by the user is not accepted by that.
        fs::remove_file(dir.path().join("linker.md")).unwrap();
        core.call("note.create", json!({ "path": "linker.md", "content": "another\n", "own": true })).unwrap();
        assert_eq!(waiting(&mut core), ["linker.md changed +1 -1"]);
        // The same by someone else.
        core.call("note.delete", json!({ "path": "busy.md" })).unwrap();
        core.call("note.create", json!({ "path": "theirs.md", "content": "theirs\n" })).unwrap();
        assert_eq!(waiting(&mut core), ["busy.md deleted +0 -1", "linker.md changed +1 -1", "theirs.md added +1 -0"]);

        // Where review was never used, the user's own operation does not start it.
        let (dir, state) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        git_as(dir.path(), "Ana", &["init", "-q"]);
        fs::write(dir.path().join("a.md"), "one\n").unwrap();
        git_as(dir.path(), "Ana", &["add", "-A"]);
        git_as(dir.path(), "Ana", &["commit", "-q", "-m", "first"]);
        let mut core = Core::new();
        core.set_state_dir(state.path());
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        core.call("note.delete", json!({ "path": "a.md", "own": true })).unwrap();
        assert!(!state.path().join("review").exists());
    }

    #[test]
    fn the_git_and_review_operations_run_without_the_core() {
        assert!(matches!(Core::new().outside(), Err(Error::NoVault)));
        for name in ["git.log", "git.show", "git.blame", "review.list", "review.base", "review.accept", "review.saved"] {
            assert!(Outside::has(name), "{name}");
        }
        for name in ["note.read", "note.write", "vault.health", "claims.check", "search"] {
            assert!(!Outside::has(name), "{name}");
        }
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let (dir, _state, mut core) = review_vault(&[("a.md", "one\n")]);
        fs::write(dir.path().join("a.md"), "one\ntwo\n").unwrap();
        let outside = core.outside().unwrap();
        let through_core = ["git.log", "git.blame", "review.list"].map(|name| core.call(name, json!({ "path": "a.md" })).unwrap());
        // The core is gone, as it is let go of by a host: what was taken out of it is enough.
        drop(core);
        assert_eq!(["git.log", "git.blame", "review.list"].map(|name| outside.run(name, json!({ "path": "a.md" })).unwrap()), through_core);
        assert_eq!(outside.run("review.list", Value::Null).unwrap()["entries"][0]["path"], "a.md");
        assert_eq!(outside.run("git.show", json!({ "path": "a.md" })).unwrap(), json!({ "content": "one\n" }));
        outside.run("review.accept", json!({ "path": "a.md" })).unwrap();
        assert_eq!(outside.run("review.list", Value::Null).unwrap()["entries"], json!([]));
        // The same checks as through the core: a dot path, and an operation that is not one of these.
        assert!(matches!(outside.run("git.log", json!({ "path": ".git/config" })), Err(Error::BadPath(_))));
        assert!(matches!(outside.run("note.read", json!({ "path": "a.md" })), Err(Error::UnknownCall(_))));
        assert!(matches!(outside.run("git.push", Value::Null), Err(Error::UnknownCall(_))));
    }

    #[test]
    fn review_reads_git_without_writing_to_the_repository() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let vault = dir.path();
        git_as(vault, "Ana", &["init", "-q"]);
        fs::write(vault.join("a.md"), "one\n").unwrap();
        fs::write(vault.join("b.md"), "one\n").unwrap();
        git_as(vault, "Ana", &["add", "-A"]);
        git_as(vault, "Ana", &["commit", "-q", "-m", "first"]);
        let mut core = Core::new();
        core.set_state_dir(state.path());
        core.call("vault.open", json!({ "path": vault })).unwrap();
        core.call("review.list", Value::Null).unwrap();
        fs::write(vault.join("a.md"), "two\n").unwrap();
        // A new time with the same text: what makes `git diff` want to write the index.
        fs::write(vault.join("b.md"), "one\n").unwrap();
        let everything = |folder: &std::path::Path| {
            let mut files = Vec::new();
            let mut folders = vec![folder.to_path_buf()];
            while let Some(folder) = folders.pop() {
                for entry in fs::read_dir(folder).unwrap() {
                    let path = entry.unwrap().path();
                    if path.is_dir() { folders.push(path) } else { files.push((path.clone(), fs::read(&path).unwrap())) }
                }
            }
            files.sort();
            files
        };
        let before = everything(vault);

        assert_eq!(core.call("review.list", Value::Null).unwrap()["entries"].as_array().unwrap().len(), 1);
        core.call("review.base", json!({ "path": "a.md" })).unwrap();
        core.call("review.saved", json!({ "path": "b.md", "before": "one\n", "after": "one\n" })).unwrap();
        core.call("review.accept", json!({ "path": "a.md" })).unwrap();
        core.call("review.accept", json!({})).unwrap();
        assert_eq!(core.call("review.list", Value::Null).unwrap()["entries"], json!([]));
        // Every file of the vault and of `.git` is byte for byte what it was.
        assert_eq!(everything(vault), before);
    }

    #[test]
    fn review_in_a_vault_without_a_repository_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "one\n").unwrap();
        let mut core = Core::new();
        core.set_state_dir(state.path());
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        assert_eq!(core.call("review.list", Value::Null).unwrap(), json!({ "repository": false, "entries": [] }));
        assert_eq!(core.call("review.base", json!({ "path": "a.md" })).unwrap(), json!({ "content": null }));
        core.call("review.accept", json!({})).unwrap();
        core.call("review.saved", json!({ "path": "a.md", "before": "one\n", "after": "two\n" })).unwrap();
        assert!(!dir.path().join(".git").exists());
        assert!(!state.path().join("review").exists());
    }

    #[test]
    fn claims_are_listed_and_checked_and_a_command_runs_only_when_allowed() {
        let (dir, state, marks) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mark = marks.path().join("ran");
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/b.md"), "Spec. <!-- check: file a.md -->\n").unwrap();
        fs::write(dir.path().join("a.md"), format!("# A\nRuns. <!-- check: touch {} -->\n```\nNot one. <!-- check: true -->\n```\n", mark.display())).unwrap();
        let mut core = Core::new();
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        assert!(matches!(core.call("claims.list", Value::Null), Err(Error::NoStateFolder)));
        assert!(matches!(core.call("claims.check", json!({ "path": "a.md", "line": 2 })), Err(Error::NoStateFolder)));
        core.set_state_dir(state.path());

        let touch = format!("touch {}", mark.display());
        let unchecked = |path: &str, line: u32, text: &str, evidence: &str, kind: &str| json!({ "path": path, "line": line, "text": text, "evidence": evidence, "kind": kind, "status": "unchecked", "checked": null, "output": null });
        let listed = json!([unchecked("a.md", 2, "Runs.", &touch, "command"), unchecked("sub/b.md", 1, "Spec.", "file a.md", "file")]);
        assert_eq!(core.call("claims.list", Value::Null).unwrap(), listed);

        // Without `commands: true`, in whatever form the params come, the command does not run.
        let refused = [json!({ "path": "a.md", "line": 2 }), json!({ "path": "a.md", "line": 2, "commands": false }), json!({ "path": "a.md", "line": 2, "commands": "true" })];
        for params in refused {
            let error = core.call("claims.check", params.clone()).unwrap_err();
            assert_eq!(error.to_string(), "commands are not allowed for this vault", "{params}");
        }
        // Params as a list, which could be read as `{path, line, commands}` in that order, are refused whole.
        assert!(matches!(core.call("claims.check", json!(["a.md", 2, true])), Err(Error::BadParams(..))));
        assert!(!mark.exists());
        assert_eq!(core.call("claims.list", Value::Null).unwrap(), listed);

        let checked = core.call("claims.check", json!({ "path": "a.md", "line": 2, "commands": true })).unwrap();
        assert_eq!((&checked["status"], &checked["output"], checked["checked"].as_str().map(str::len)), (&json!("passing"), &json!("exit status 0"), Some(10)));
        assert!(mark.exists());
        // A file claim needs no `commands`.
        assert_eq!(core.call("claims.check", json!({ "path": "sub/b.md", "line": 1 })).unwrap()["status"], "passing");
        let list = core.call("claims.list", Value::Null).unwrap();
        assert_eq!(list[0], checked);
        assert_eq!((&list[1]["status"], &list[1]["output"]), (&json!("passing"), &Value::Null));

        for (params, wanted) in [(json!({ "path": "a.md", "line": 1, "commands": true }), "no claim on line 1 of a.md"), (json!({ "path": "a.md", "line": 4, "commands": true }), "no claim on line 4 of a.md")] {
            assert_eq!(core.call("claims.check", params).unwrap_err().to_string(), wanted);
        }
        assert!(matches!(core.call("claims.check", json!({ "path": ".inklode/x.md", "line": 1 })), Err(Error::BadPath(_))));
        assert!(matches!(core.call("claims.check", json!({ "path": "a.md" })), Err(Error::BadParams(..))));
        // Nothing of this is in the vault.
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn a_write_from_outside_sends_an_event_and_is_seen_by_the_next_query() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::new();
        let (sender, events) = mpsc::channel();
        core.set_listener(move |event| {
            let _ = sender.send(event);
        });
        let info = core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        assert!(core.call("search", json!({ "query": "zebra" })).unwrap().as_array().unwrap().is_empty());

        // Write below the canonical root, as another app would.
        let root = std::path::PathBuf::from(info["root"].as_str().unwrap());
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ignored").unwrap();
        fs::create_dir_all(root.join(".inklode")).unwrap();
        fs::write(root.join(".inklode/settings.json"), "{}").unwrap();
        fs::write(root.join("new.md"), "a zebra\n").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let (mut seen, mut config): (Vec<Value>, Vec<Value>) = Default::default();
        while !seen.iter().any(|path| path == "new.md") || config.is_empty() {
            let left = deadline.saturating_duration_since(Instant::now());
            let event = events.recv_timeout(left).expect("no event for new.md or .inklode/settings.json");
            let paths = event["paths"].as_array().unwrap().iter().cloned();
            match event["type"].as_str().unwrap() {
                "vault.changed" => seen.extend(paths),
                "config.changed" => config.extend(paths),
                other => panic!("unexpected event {other}"),
            }
        }
        assert!(!seen.iter().any(|path| path.as_str().unwrap().starts_with('.')), "{seen:?}");
        assert_eq!(config, [".inklode/settings.json"]);

        let found = core.call("search", json!({ "query": "zebra" })).unwrap();
        assert_eq!(found, json!([{ "path": "new.md", "line": 1, "text": "a zebra" }]));
    }
}
