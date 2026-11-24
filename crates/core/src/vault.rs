use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;

use crate::Error;

/// A folder of notes. All paths passed in and out are relative to the vault
/// root and use forward slashes, on every platform.
#[derive(Clone)]
pub struct Vault {
    root: PathBuf,
}

/// One file for `Vault::write_all`: its path, its whole new text, and `base` as `Vault::write_over` takes it.
pub struct Write<'a> {
    pub path: &'a str,
    pub content: &'a str,
    pub base: Option<&'a str>,
}

/// How many files `Vault::write_all` flushes at once. More than this gains little: 1556 files took
/// 2.5 s with 4, 1.6 s with 8, 1.2 s with 16.
const FLUSHERS: usize = 16;

/// A file of `Vault::write_all` whose new text is in its temporary file.
struct Staged {
    /// The file's real path.
    path: PathBuf,
    tmp: PathBuf,
}

impl Staged {
    /// The second pass: the temporary file is on the disk when this returns. It is opened
    /// again for that, so that a thousand files are not all held open from the first pass on.
    fn flush(&self) -> std::io::Result<()> {
        fs::OpenOptions::new().write(true).open(&self.tmp)?.sync_all()
    }

    /// The third pass: the temporary file takes the file's place, unless the file is no
    /// longer what `base` says, which is `false`.
    fn land(&self, base: Option<&str>) -> std::io::Result<bool> {
        // The rename replaces the file, so carry its permissions over.
        if let Ok(meta) = fs::metadata(&self.path) {
            fs::set_permissions(&self.tmp, meta.permissions())?;
        }
        if changed(&self.path, base)? {
            return Ok(false);
        }
        fs::rename(&self.tmp, &self.path).map(|()| true)
    }
}

/// Whether the file at `path` holds something else than `base`, the text a writer last read.
/// A missing file counts as empty. Without a `base` nothing is asked.
fn changed(path: &Path, base: Option<&str>) -> std::io::Result<bool> {
    let Some(base) = base else { return Ok(false) };
    match fs::read(path) {
        Ok(now) => Ok(now != base.as_bytes()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(!base.is_empty()),
        Err(e) => Err(e),
    }
}

/// `work` for each of `items`, on up to `threads` threads at once, with the answers in the
/// order of `items`. Every item is worked on, whatever the answer for another was.
fn each<T: Sync, R: Send>(items: &[T], threads: usize, work: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = threads.min(items.len());
    if threads <= 1 {
        return items.iter().map(work).collect();
    }
    // Each thread takes the next item nobody has taken, so a slow one holds up no other.
    let next = AtomicUsize::new(0);
    let mut answers: Vec<(usize, R)> = std::thread::scope(|scope| {
        let take = || {
            let mut mine = Vec::new();
            loop {
                let at = next.fetch_add(1, Ordering::Relaxed);
                let Some(item) = items.get(at) else { return mine };
                mine.push((at, work(item)));
            }
        };
        let workers: Vec<_> = (0..threads).map(|_| scope.spawn(take)).collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))).collect()
    });
    answers.sort_by_key(|(at, _)| *at);
    answers.into_iter().map(|(_, answer)| answer).collect()
}

/// One file or folder in the tree. `children` is present only for folders.
#[derive(Debug, Serialize, PartialEq)]
pub struct Entry {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Entry>>,
}

impl Vault {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref();
        let root = fs::canonicalize(path).map_err(|e| io_err(path, e))?;
        if !root.is_dir() {
            return Err(Error::NotAFolder(root.display().to_string()));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The folder name, used as the vault's display name.
    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.display().to_string())
    }

    /// Every file and folder, folders first, then by name ignoring case.
    /// Names starting with a dot (`.git`, `.obsidian`, `.inklode`) are left out.
    pub fn tree(&self) -> Result<Vec<Entry>, Error> {
        list(&self.root, &self.root, "", &mut vec![self.root.clone()])
    }

    pub fn read(&self, rel: &str) -> Result<String, Error> {
        let path = self.resolve(rel)?;
        fs::read_to_string(&path).map_err(|e| io_err(&path, e))
    }

    /// Writes the whole file through a temporary file and a rename, so a crash
    /// or a second app reading the vault never sees a half-written note.
    pub fn write(&self, rel: &str, content: &str) -> Result<(), Error> {
        self.write_over(rel, content, None)
    }

    /// `write`, but with a `base` the file must still hold exactly those bytes,
    /// or nothing is written and the error is `Conflict`. `base` is the text the
    /// caller last read or wrote. A missing file counts as empty, so it conflicts
    /// with any base but the empty one.
    // shortcut: nothing locks the file, so a change made by another program between the
    // last comparison and the rename (a few system calls) is still replaced; lock the
    // file or compare-and-swap through a hard link if two writers have to be exact.
    pub fn write_over(&self, rel: &str, content: &str, base: Option<&str>) -> Result<(), Error> {
        self.write_all(&[Write { path: rel, content, base }]).pop().expect("one answer per file")
    }

    /// `write_over` for many files at once, with the answer for each in their order. A file
    /// that cannot be written keeps what it had and does not stop the others. No two of
    /// `files` may have the same path.
    ///
    /// Each file is written as one alone is: to a temporary file, which is flushed to the
    /// disk and then takes the file's place. The three steps are three passes over all the
    /// files, because the flush is nearly all of the time and the disk answers several
    /// that wait together sooner than the same ones in a row: 1556 notes took 6.8 s one by
    /// one and 1.2 s this way (an Apple SSD, where the flush is `F_FULLFSYNC`).
    pub fn write_all(&self, files: &[Write]) -> Vec<Result<(), Error>> {
        let staged: Vec<Result<Staged, Error>> = files.iter().map(|file| self.stage(file)).collect();
        let flushed = each(&staged, FLUSHERS, |staged| staged.as_ref().map_or(Ok(()), Staged::flush));
        let land = |((staged, flushed), file): ((Result<Staged, Error>, std::io::Result<()>), &Write)| {
            let staged = staged?;
            // Checked once more right before the file is replaced, when the slow part is done.
            let landed = flushed.and_then(|()| staged.land(file.base));
            if !matches!(landed, Ok(true)) {
                let _ = fs::remove_file(&staged.tmp);
            }
            match landed {
                Ok(true) => Ok(()),
                Ok(false) => Err(Error::Conflict(file.path.to_string())),
                Err(e) => Err(io_err(&staged.path, e)),
            }
        };
        staged.into_iter().zip(flushed).zip(files).map(land).collect()
    }

    /// The first pass of `write_all` for one file: its text is in its temporary file, which
    /// is not flushed yet. Nothing is made, not a folder either, for a file that is not what `base` says.
    fn stage(&self, file: &Write) -> Result<Staged, Error> {
        let path = self.resolve(file.path)?;
        if changed(&path, file.base).map_err(|e| io_err(&path, e))? {
            return Err(Error::Conflict(file.path.to_string()));
        }
        let dir = path.parent().unwrap_or(&self.root);
        fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
        let tmp = dir.join(format!(".{file_name}.inklode-tmp"));
        let written = fs::File::create(&tmp).and_then(|mut to| to.write_all(file.content.as_bytes()));
        if let Err(e) = written {
            let _ = fs::remove_file(&tmp);
            return Err(io_err(&path, e));
        }
        Ok(Staged { path, tmp })
    }

    /// Makes a new file, and the folders above it. Fails with `Exists` when
    /// anything has that path, and the disk is the judge of that: on macOS a name
    /// that differs only in case or in Unicode normal form is the same file.
    pub fn create(&self, rel: &str, content: &str) -> Result<(), Error> {
        self.create_new(rel)?;
        if content.is_empty() { Ok(()) } else { self.write(rel, content) }
    }

    /// `create` for a file that is not text, such as a pasted image. The bytes go straight into the new
    /// file, which is removed again if they cannot all be written.
    pub fn create_bytes(&self, rel: &str, bytes: &[u8]) -> Result<(), Error> {
        let (path, mut file) = self.create_new(rel)?;
        file.write_all(bytes).and_then(|()| file.sync_all()).map_err(|e| {
            let _ = fs::remove_file(&path);
            io_err(&path, e)
        })
    }

    /// Takes the name `rel` for a new, empty file, and makes the folders above it.
    fn create_new(&self, rel: &str) -> Result<(PathBuf, fs::File), Error> {
        let path = self.resolve(rel)?;
        if hidden(rel) {
            return Err(Error::BadPath(rel.to_string()));
        }
        let dir = path.parent().unwrap_or(&self.root);
        fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
        // `create_new` takes the name and fails if it is taken, in one step.
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(Error::Exists(rel.to_string())),
            Err(e) => Err(io_err(&path, e)),
        }
    }

    /// `rel` as the disk spells it. On a disk that ignores case or Unicode normal
    /// form (macOS), a path reaches a file whose name is written another way, and
    /// the tree and the index only know the name. `NotFound` if nothing is there.
    pub fn spelled(&self, rel: &str) -> Result<String, Error> {
        self.resolve(rel)?;
        let mut dir = self.root.clone();
        let mut parts = Vec::new();
        for part in rel.split('/') {
            let names: Vec<String> = fs::read_dir(&dir)
                .map_err(|_| Error::NotFound(rel.to_string()))?
                .filter_map(|item| Some(item.ok()?.file_name().to_string_lossy().into_owned()))
                .collect();
            // `canonicalize` gives a path with the names as stored, so two spellings of one file come out equal.
            let same = |name: &&String| fs::canonicalize(dir.join(part)).is_ok_and(|real| fs::canonicalize(dir.join(name)).ok() == Some(real));
            let name = names.iter().find(|name| *name == part).or_else(|| names.iter().find(same));
            let name = name.ok_or_else(|| Error::NotFound(rel.to_string()))?.clone();
            dir.push(&name);
            parts.push(name);
        }
        Ok(parts.join("/"))
    }

    /// Moves a file or a whole folder, creating the folders `to` needs. Fails when
    /// `from` is missing or `to` is taken: a folder is never merged into another.
    /// A folder cannot move into itself, and nothing under a dot name (`.inklode`,
    /// `.trash`, `.git`) is moved, replaced or made: not a folder, and not a file.
    pub fn rename(&self, from: &str, to: &str) -> Result<(), Error> {
        // The entries themselves: a symbolic link moves as a link, and what it points to stays.
        let (src, dst) = (self.entry(from)?, self.entry(to)?);
        if src.is_dir() {
            // Compared without case, as a case-insensitive disk sees the paths.
            let inside = format!("{}/", to.to_lowercase()).starts_with(&format!("{}/", from.to_lowercase()));
            if hidden(from) || hidden(to) || (inside && to.len() != from.len()) {
                return Err(Error::BadMove(from.to_string(), to.to_string()));
            }
        } else if hidden(from) || hidden(to) {
            return Err(Error::BadPath(if hidden(from) { from } else { to }.to_string()));
        } else if !src.is_file() {
            return Err(Error::NotFound(from.to_string()));
        }
        // On a case-insensitive disk, a rename that only changes case finds the note itself at `to`.
        let is_itself = fs::canonicalize(&dst).ok() == fs::canonicalize(&src).ok();
        if dst.exists() && !is_itself {
            return Err(Error::Exists(to.to_string()));
        }
        let dir = dst.parent().unwrap_or(&self.root);
        fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
        fs::rename(&src, &dst).map_err(|e| io_err(&src, e))
    }

    pub fn is_folder(&self, rel: &str) -> bool {
        self.resolve(rel).is_ok_and(|path| path.is_dir())
    }

    /// Makes an empty folder, and the folders above it. Fails when something has that path.
    pub fn create_folder(&self, rel: &str) -> Result<(), Error> {
        let path = self.resolve(rel)?;
        if hidden(rel) {
            return Err(Error::BadPath(rel.to_string()));
        }
        if path.exists() {
            return Err(Error::Exists(rel.to_string()));
        }
        fs::create_dir_all(&path).map_err(|e| io_err(&path, e))
    }

    /// Deletes a file by moving it to `.trash/` at the vault root, under the same
    /// relative path, so nothing is ever unlinked. A name that is taken there gets
    /// a number: `a.md`, `a 2.md`, `a 3.md`, and so does a folder above it whose
    /// name a file there has. Returns the path it now has.
    /// A file under a dot name is not a note and is not moved.
    pub fn trash(&self, rel: &str) -> Result<String, Error> {
        let path = self.resolve(rel)?;
        if hidden(rel) {
            return Err(Error::BadPath(rel.to_string()));
        }
        if !path.is_file() {
            return Err(Error::NotFound(rel.to_string()));
        }
        let (stem, ext) = match rel.rsplit_once('.') {
            // A dot in a folder name or at the start of the file name is not an extension.
            Some((stem, ext)) if !ext.contains('/') && !stem.is_empty() && !stem.ends_with('/') => (stem, format!(".{ext}")),
            _ => (rel, String::new()),
        };
        self.to_trash(rel, stem, &ext)
    }

    /// Deletes a folder with everything in it the way `trash` deletes a file:
    /// one move into `.trash/`, numbered when the name is taken there.
    pub fn trash_folder(&self, rel: &str) -> Result<String, Error> {
        if !self.resolve(rel)?.is_dir() || hidden(rel) {
            return Err(Error::NotFound(rel.to_string()));
        }
        self.to_trash(rel, rel, "")
    }

    fn to_trash(&self, rel: &str, stem: &str, ext: &str) -> Result<String, Error> {
        let src = self.root.join(rel);
        let (folders, name) = rel.rsplit_once('/').map_or(("", rel), |(folders, name)| (folders, name));
        // The folders above it, made in the trash as needed. One whose name a file in
        // the trash has cannot be made, so it gets a number as the final name does:
        // `.trash/a` a file sends `a/b.md` to `.trash/a 2/b.md`.
        let mut dir = String::from(".trash");
        for part in folders.split('/').filter(|part| !part.is_empty()) {
            let mut next = format!("{dir}/{part}");
            let mut n = 1;
            while self.root.join(&next).exists() && !self.root.join(&next).is_dir() {
                n += 1;
                next = format!("{dir}/{part} {n}");
            }
            dir = next;
        }
        let stem = &name[..name.len() - (rel.len() - stem.len())];
        let mut to = format!("{dir}/{name}");
        let mut n = 1;
        while self.root.join(&to).exists() {
            n += 1;
            to = format!("{dir}/{stem} {n}{ext}");
        }
        // Refused when `.trash` or a folder in it is a link to another place.
        let dst = self.resolve(&to)?;
        let dir = dst.parent().unwrap_or(&self.root);
        fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
        fs::rename(&src, &dst).map_err(|e| io_err(&src, e))?;
        Ok(to)
    }

    /// The names of the `.css` files directly in the folder `rel`, without the
    /// extension, sorted. A missing folder gives an empty list.
    pub fn css_names(&self, rel: &str) -> Result<Vec<String>, Error> {
        let dir = self.resolve(rel)?;
        let items = match fs::read_dir(&dir) {
            Ok(items) => items,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_err(&dir, e)),
        };
        let mut names: Vec<String> = items
            .filter_map(|item| Some(item.ok()?.path()))
            .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "css"))
            .filter_map(|path| Some(path.file_stem()?.to_string_lossy().into_owned()))
            .collect();
        names.sort();
        Ok(names)
    }

    /// Turns a vault-relative path into the absolute path of the file it reaches. Rejects
    /// absolute paths and `..`, and follows symbolic links itself: a link that leads to a
    /// place in the vault gives that place, so a read or a write goes to the file the link
    /// points to; one that leads out of the vault, or to a dot name the path does not spell
    /// out, is refused with `Outside`. So a call can never reach outside the vault.
    // shortcut: the check and the use of the path are two steps, so a program that swaps a
    // folder for a link between them is not stopped; open each part with `O_NOFOLLOW` (openat)
    // if the vault has to hold against a program running at the same time.
    pub(crate) fn resolve(&self, rel: &str) -> Result<PathBuf, Error> {
        real(&self.root, rel)
    }

    /// Like `resolve` for the folder the path is in, with the last name left as it is: the
    /// path of the entry itself, which for a symbolic link is the link and not what it
    /// points to. For the operations that move an entry.
    fn entry(&self, rel: &str) -> Result<PathBuf, Error> {
        match rel.rsplit_once('/') {
            Some((dir, name)) => Ok(real(&self.root, dir)?.join(checked(name)?)),
            None => Ok(self.root.join(checked(rel)?)),
        }
    }
}

/// `rel` if it is a path that stays under the folder it is joined to: not empty, not
/// absolute, and without `.` and `..` parts.
fn checked(rel: &str) -> Result<&Path, Error> {
    let path = Path::new(rel);
    let inside = !rel.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)));
    if inside { Ok(path) } else { Err(Error::BadPath(rel.to_string())) }
}

/// `Vault::resolve` for the vault at `root`, which is a real path (`Vault::open` makes it one).
pub(crate) fn real(root: &Path, rel: &str) -> Result<PathBuf, Error> {
    let path = root.join(checked(rel)?);
    // The deepest part of the path that exists, as a real path. What comes after it does
    // not exist, so it holds no link.
    let mut exists = path.clone();
    let mut missing = Vec::new();
    let found = loop {
        match fs::canonicalize(&exists) {
            Ok(found) => break found,
            // A link whose target is missing, or a loop of links: where a write through it would land is not known.
            Err(_) if fs::symlink_metadata(&exists).is_ok_and(|meta| meta.is_symlink()) => return Err(Error::Outside(rel.to_string())),
            Err(e) => match (exists.file_name().map(|name| name.to_os_string()), exists.parent().map(Path::to_path_buf)) {
                (Some(name), Some(parent)) if parent.starts_with(root) => {
                    missing.push(name);
                    exists = parent;
                }
                _ => return Err(io_err(&path, e)),
            },
        }
    };
    let inside = found.strip_prefix(root).map_err(|_| Error::Outside(rel.to_string()))?;
    // A link must not lead to a dot name either (`note.md -> .git/config`): the real path
    // has the dot names the path spells out, and no other.
    let dots = |names: &mut dyn Iterator<Item = &str>| names.filter(|name| name.starts_with('.')).map(str::to_lowercase).collect::<Vec<_>>();
    let spelled = rel.split('/').count() - missing.len();
    if dots(&mut inside.iter().filter_map(|name| name.to_str())) != dots(&mut rel.split('/').take(spelled)) {
        return Err(Error::Outside(rel.to_string()));
    }
    Ok(missing.iter().rev().fold(found, |path, name| path.join(name)))
}

/// The tree under `dir`, a real path in the vault at `root`. A symbolic link is listed as
/// what it points to when that is in the vault and under no dot name, and is left out
/// otherwise. `above` has the real paths of the folders being listed, `dir` included: a
/// link back to one of them is left out, so a loop of links ends.
fn list(root: &Path, dir: &Path, prefix: &str, above: &mut Vec<PathBuf>) -> Result<Vec<Entry>, Error> {
    let mut entries = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| io_err(dir, e))? {
        let item = item.map_err(|e| io_err(dir, e))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        // file_type does not follow symlinks.
        let kind = item.file_type().map_err(|e| io_err(dir, e))?;
        let (is_dir, at) = if kind.is_symlink() {
            match real(root, &path) {
                Ok(target) if !above.contains(&target) => (target.is_dir(), target),
                _ => continue,
            }
        } else {
            (kind.is_dir(), item.path())
        };
        let children = if is_dir {
            above.push(at.clone());
            let children = list(root, &at, &path, above);
            above.pop();
            Some(children?)
        } else {
            None
        };
        entries.push(Entry {
            name,
            path,
            children,
        });
    }
    entries.sort_by(|a, b| {
        (a.children.is_none(), a.name.to_lowercase()).cmp(&(b.children.is_none(), b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Whether any part of the path starts with a dot: a dot folder, something in one, or a dot file.
pub(crate) fn hidden(rel: &str) -> bool {
    rel.split('/').any(|part| part.starts_with('.'))
}

fn io_err(path: &Path, e: std::io::Error) -> Error {
    Error::Io(path.display().to_string(), e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Projects")).unwrap();
        fs::create_dir_all(dir.path().join(".obsidian")).unwrap();
        fs::write(dir.path().join("Home.md"), "# Home\n").unwrap();
        fs::write(dir.path().join("apple.md"), "").unwrap();
        fs::write(dir.path().join("Projects/inklode.md"), "notes").unwrap();
        fs::write(dir.path().join(".obsidian/app.json"), "{}").unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        (dir, vault)
    }

    #[test]
    fn many_files_written_at_once_are_each_written_or_left_as_they_were() {
        let (dir, vault) = sample();
        // More files than are flushed at once, so every thread has some.
        let count = 5 * FLUSHERS + 3;
        let paths: Vec<String> = (0..count).map(|n| format!("Many/{}/note {n}.md", n % 7)).collect();
        let old = |n: usize| format!("old {n}\n");
        let new = |n: usize| format!("new {n}\n{}", "more text\n".repeat(n));
        for (n, path) in paths.iter().enumerate().filter(|(n, _)| n % 2 == 0) {
            fs::create_dir_all(dir.path().join(path).parent().unwrap()).unwrap();
            fs::write(dir.path().join(path), old(n)).unwrap();
        }
        let texts: Vec<(String, String)> = (0..count).map(|n| (old(n), new(n))).collect();
        // Every second file is there and is written over what it has, the others are new. Three cannot be
        // written: one is not what its `base` says, one should be there and is not, one has a path out of the vault.
        let (stale, missing, outside) = (4, 9, 16);
        let files: Vec<Write> = (0..count)
            .map(|n| {
                let base = if n == stale { Some("something else") } else if n % 2 == 0 || n == missing { Some(texts[n].0.as_str()) } else { None };
                Write { path: if n == outside { "../out.md" } else { &paths[n] }, content: &texts[n].1, base }
            })
            .collect();
        let answers = vault.write_all(&files);
        assert_eq!(answers.len(), count);
        for (n, answer) in answers.iter().enumerate() {
            let now = fs::read_to_string(dir.path().join(&paths[n])).ok();
            if n == stale {
                assert!(matches!(answer, Err(Error::Conflict(path)) if *path == paths[n]), "{n}");
                assert_eq!(now, Some(old(n)));
            } else if n == missing {
                assert!(matches!(answer, Err(Error::Conflict(_))), "{n}");
                assert_eq!(now, None);
            } else if n == outside {
                assert!(matches!(answer, Err(Error::BadPath(_))), "{n}");
            } else {
                assert!(answer.is_ok(), "{n}: {answer:?}");
                assert_eq!(now, Some(new(n)), "{n}");
            }
        }
        // No temporary file is left, of a file that was written or of one that was not.
        fn left(dir: &Path, found: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                if entry.path().is_dir() {
                    left(&entry.path(), found);
                } else if entry.file_name().to_string_lossy().ends_with(".inklode-tmp") {
                    found.push(entry.path());
                }
            }
        }
        let mut found = Vec::new();
        left(dir.path(), &mut found);
        assert_eq!(found, Vec::<PathBuf>::new());
        assert!(!dir.path().parent().unwrap().join("out.md").exists());
        // No file is no work, and one file is `write_over`.
        assert!(vault.write_all(&[]).is_empty());
        vault.write_over(&paths[0], "again\n", Some(&new(0))).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join(&paths[0])).unwrap(), "again\n");
    }

    #[test]
    fn tree_lists_folders_first_and_skips_dot_names() {
        let (_dir, vault) = sample();
        let tree = vault.tree().unwrap();
        let names: Vec<_> = tree.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Projects", "apple.md", "Home.md"]);
        let children = tree[0].children.as_ref().unwrap();
        assert_eq!(children[0].path, "Projects/inklode.md");
        assert!(tree[1].children.is_none());
    }

    #[test]
    fn write_then_read_returns_the_same_text() {
        let (dir, vault) = sample();
        vault.write("Home.md", "# Changed\r\n").unwrap();
        assert_eq!(vault.read("Home.md").unwrap(), "# Changed\r\n");
        vault.write("New/deep.md", "x").unwrap();
        assert_eq!(vault.read("New/deep.md").unwrap(), "x");
        // No temporary file is left behind.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".inklode-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn paths_outside_the_vault_are_rejected() {
        let (_dir, vault) = sample();
        for bad in ["../x.md", "/etc/passwd", "a/../../x.md", ""] {
            assert!(matches!(vault.read(bad), Err(Error::BadPath(_))), "{bad}");
            assert!(matches!(vault.write(bad, ""), Err(Error::BadPath(_))), "{bad}");
        }
    }

    #[test]
    fn trash_moves_the_file_and_numbers_a_taken_name() {
        let (dir, vault) = sample();
        assert_eq!(vault.trash("Projects/inklode.md").unwrap(), ".trash/Projects/inklode.md");
        assert!(!dir.path().join("Projects/inklode.md").exists());
        assert_eq!(fs::read_to_string(dir.path().join(".trash/Projects/inklode.md")).unwrap(), "notes");

        // The same path deleted again keeps both copies.
        vault.write("Projects/inklode.md", "second").unwrap();
        assert_eq!(vault.trash("Projects/inklode.md").unwrap(), ".trash/Projects/inklode 2.md");
        vault.write("Projects/inklode.md", "third").unwrap();
        assert_eq!(vault.trash("Projects/inklode.md").unwrap(), ".trash/Projects/inklode 3.md");
        assert_eq!(fs::read_to_string(dir.path().join(".trash/Projects/inklode.md")).unwrap(), "notes");

        // The trash is a dot folder, so the tree does not show it.
        assert!(vault.tree().unwrap().iter().all(|e| e.name != ".trash"));
        assert!(matches!(vault.trash("nope.md"), Err(Error::NotFound(_))));
        assert!(matches!(vault.trash("Projects"), Err(Error::NotFound(_))));
        assert!(matches!(vault.trash("../x.md"), Err(Error::BadPath(_))));
    }

    #[test]
    fn trash_numbers_a_folder_whose_name_a_trashed_file_has() {
        let (dir, vault) = sample();
        let root = dir.path();
        // A file without an extension was trashed under the name the folder now needs.
        fs::create_dir_all(root.join(".trash")).unwrap();
        fs::write(root.join(".trash/Projects"), "a file").unwrap();
        vault.write("Projects/deep/a.md", "deep").unwrap();

        assert_eq!(vault.trash("Projects/inklode.md").unwrap(), ".trash/Projects 2/inklode.md");
        assert_eq!(fs::read_to_string(root.join(".trash/Projects 2/inklode.md")).unwrap(), "notes");
        assert_eq!(fs::read_to_string(root.join(".trash/Projects")).unwrap(), "a file");
        // The numbered folder is used again, and the final name is numbered in it as before.
        vault.write("Projects/inklode.md", "second").unwrap();
        assert_eq!(vault.trash("Projects/inklode.md").unwrap(), ".trash/Projects 2/inklode 2.md");
        assert_eq!(vault.trash_folder("Projects/deep").unwrap(), ".trash/Projects 2/deep");
        assert_eq!(vault.read(".trash/Projects 2/deep/a.md").unwrap(), "deep");
    }

    #[test]
    fn folders_move_whole_are_trashed_whole_and_are_created_empty() {
        let (dir, vault) = sample();
        let root = dir.path();
        fs::create_dir_all(root.join("Projects/img")).unwrap();
        fs::write(root.join("Projects/img/pic.png"), [0u8, 159, 146, 150]).unwrap();
        fs::create_dir_all(root.join("Other")).unwrap();

        // Into itself or a folder inside it, onto something that exists, and anything with a dot folder.
        for to in ["Projects/sub", "Projects/img/deeper", "projects/x"] {
            assert!(matches!(vault.rename("Projects", to), Err(Error::BadMove(..))), "{to}");
        }
        assert!(matches!(vault.rename("Projects", "Other"), Err(Error::Exists(_))));
        assert!(matches!(vault.rename("Projects", ".trash/Projects"), Err(Error::BadMove(..))));
        assert!(matches!(vault.rename(".obsidian", "Settings"), Err(Error::BadMove(..))));
        assert!(root.join("Projects/inklode.md").exists());

        vault.rename("Projects", "Other/Work").unwrap();
        assert!(!root.join("Projects").exists());
        assert_eq!(vault.read("Other/Work/inklode.md").unwrap(), "notes");
        assert_eq!(fs::read(root.join("Other/Work/img/pic.png")).unwrap(), [0u8, 159, 146, 150]);

        vault.create_folder("New/Deep").unwrap();
        assert!(vault.is_folder("New/Deep") && !vault.is_folder("Home.md") && !vault.is_folder("nope"));
        assert!(matches!(vault.create_folder("New"), Err(Error::Exists(_))));
        assert!(matches!(vault.create_folder("Home.md"), Err(Error::Exists(_))));
        assert!(matches!(vault.create_folder(".hidden"), Err(Error::BadPath(_))));
        assert!(matches!(vault.create_folder("../x"), Err(Error::BadPath(_))));

        assert_eq!(vault.trash_folder("Other/Work").unwrap(), ".trash/Other/Work");
        assert_eq!(vault.read(".trash/Other/Work/inklode.md").unwrap(), "notes");
        // A dot in a folder's name is not an extension.
        vault.create_folder("Other/Work").unwrap();
        assert_eq!(vault.trash_folder("Other/Work").unwrap(), ".trash/Other/Work 2");
        vault.create_folder("v1.2").unwrap();
        vault.create_folder(".trash/v1.2").unwrap_err();
        fs::create_dir_all(root.join(".trash/v1.2")).unwrap();
        assert_eq!(vault.trash_folder("v1.2").unwrap(), ".trash/v1.2 2");
        assert!(matches!(vault.trash_folder("Home.md"), Err(Error::NotFound(_))));
        assert!(matches!(vault.trash_folder(".trash"), Err(Error::NotFound(_))));
        assert!(root.join(".trash").exists());
    }

    /// A vault with links out of it: to a file, to a folder, and through two more links.
    #[cfg(unix)]
    fn linked_out() -> (tempfile::TempDir, Vault, PathBuf) {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let (root, outside) = (dir.path().join("vault"), dir.path().join("outside"));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(outside.join("dir")).unwrap();
        fs::write(root.join("Home.md"), "# Home\n").unwrap();
        fs::write(outside.join("secret.md"), "the needle\n").unwrap();
        fs::write(outside.join("dir/o.md"), "outside needle\n").unwrap();
        symlink("../outside/secret.md", root.join("link.md")).unwrap();
        symlink(outside.join("dir"), root.join("outdir")).unwrap();
        symlink("link.md", root.join("chain1.md")).unwrap();
        symlink("../chain1.md", root.join("sub/chain2.md")).unwrap();
        let vault = Vault::open(&root).unwrap();
        (dir, vault, fs::canonicalize(outside).unwrap())
    }

    /// Every file under `dir` with its text, to see that nothing changed there.
    #[cfg(unix)]
    fn texts(dir: &Path) -> Vec<(PathBuf, String)> {
        let mut found = Vec::new();
        for item in fs::read_dir(dir).unwrap() {
            let path = item.unwrap().path();
            if path.is_dir() { found.extend(texts(&path)) } else { found.push((path.clone(), fs::read_to_string(&path).unwrap())) }
        }
        found.sort();
        found
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_vault_is_not_listed_indexed_read_or_written_through() {
        let (_dir, vault, outside) = linked_out();
        let before = texts(&outside);
        let refused = |result: Result<(), Error>, what: &str| assert!(matches!(result, Err(Error::Outside(_))), "{what}: {result:?}");

        // The tree has none of the links, so the index and search have none of what they lead to.
        let tree = vault.tree().unwrap();
        assert_eq!(tree.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["sub", "Home.md"]);
        assert_eq!(tree[0].children.as_deref(), Some(&[][..]));
        let index = crate::index::Index::build(&vault).unwrap();
        assert_eq!(index.paths().collect::<Vec<_>>(), ["Home.md"]);
        assert!(index.search("needle").is_empty());

        // A file link, a chain of links, and paths through a folder link.
        for path in ["link.md", "chain1.md", "sub/chain2.md", "outdir/o.md", "outdir/new.md", "outdir/deep/new.md", "outdir"] {
            refused(vault.read(path).map(drop), path);
            refused(vault.write(path, "planted"), path);
            refused(vault.write_over(path, "planted", Some("")), path);
            refused(vault.create(path, "planted"), path);
            refused(vault.create_folder(path), path);
            refused(vault.trash(path).map(drop), path);
            refused(vault.trash_folder(path).map(drop), path);
            refused(vault.spelled(path).map(drop), path);
            refused(vault.css_names(path).map(drop), path);
            assert!(!vault.is_folder(path), "{path}");
        }
        // Into the linked folder, and out of it.
        for (from, to) in [("Home.md", "outdir/Home.md"), ("outdir/o.md", "o.md"), ("sub", "outdir/sub"), ("Home.md", "outdir/deep/Home.md")] {
            refused(vault.rename(from, to), from);
        }
        let message = vault.read("link.md").unwrap_err().to_string();
        assert_eq!(message, "a symbolic link takes this path out of the vault, or to a name that starts with a dot: link.md");
        assert_eq!(texts(&outside), before);
        assert_eq!(vault.read("Home.md").unwrap(), "# Home\n");
        // The links are still links.
        for link in ["link.md", "outdir", "chain1.md", "sub/chain2.md"] {
            assert!(fs::symlink_metadata(vault.root().join(link)).unwrap().is_symlink(), "{link}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_dot_name_or_to_nothing_and_a_linked_trash_or_config_folder_are_refused() {
        use std::os::unix::fs::symlink;
        let (dir, vault) = sample();
        let root = dir.path();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "[core]\n").unwrap();
        symlink(".git/config", root.join("config.md")).unwrap();
        symlink(".git", root.join("gitdir")).unwrap();
        symlink(outside.path().join("not-there.md"), root.join("dangling.md")).unwrap();
        symlink("loop-b.md", root.join("loop-a.md")).unwrap();
        symlink("loop-a.md", root.join("loop-b.md")).unwrap();
        for path in ["config.md", "gitdir/config", "gitdir/hooks/pre-commit", "dangling.md", "loop-a.md"] {
            assert!(matches!(vault.read(path), Err(Error::Outside(_))), "{path}");
            assert!(matches!(vault.write(path, "x"), Err(Error::Outside(_))), "{path}");
            assert!(matches!(vault.create(path, "x"), Err(Error::Outside(_))), "{path}");
        }
        assert_eq!(fs::read_to_string(root.join(".git/config")).unwrap(), "[core]\n");
        assert!(!outside.path().join("not-there.md").exists() && !root.join(".git/hooks").exists());
        let names: Vec<String> = vault.tree().unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["Projects", "apple.md", "Home.md"]);

        // `.inklode` and `.trash` as links to another place: nothing is read from it or put there.
        fs::write(outside.path().join("settings.json"), "{}").unwrap();
        symlink(outside.path(), root.join(".inklode")).unwrap();
        symlink(outside.path(), root.join(".trash")).unwrap();
        assert!(matches!(vault.read(".inklode/settings.json"), Err(Error::Outside(_))));
        assert!(matches!(vault.write(".inklode/keys.json", "{}"), Err(Error::Outside(_))));
        assert!(matches!(vault.css_names(".inklode/themes"), Err(Error::Outside(_))));
        assert!(matches!(vault.trash("Home.md"), Err(Error::Outside(_))));
        assert!(matches!(vault.trash_folder("Projects"), Err(Error::Outside(_))));
        assert!(root.join("Home.md").exists() && root.join("Projects/inklode.md").exists());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
        // A link from one config file to a note is no way around the dot rule either.
        fs::remove_file(root.join(".inklode")).unwrap();
        fs::create_dir_all(root.join(".inklode")).unwrap();
        symlink("../.git/config", root.join(".inklode/settings.json")).unwrap();
        symlink("../Home.md", root.join(".inklode/keys.json")).unwrap();
        assert!(matches!(vault.read(".inklode/settings.json"), Err(Error::Outside(_))));
        assert!(matches!(vault.read(".inklode/keys.json"), Err(Error::Outside(_))));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_place_in_the_vault_is_what_it_points_to() {
        use std::os::unix::fs::symlink;
        let (dir, vault) = sample();
        let root = dir.path();
        symlink("Projects/inklode.md", root.join("alias.md")).unwrap();
        symlink("Projects", root.join("Work")).unwrap();
        // Loops: a folder link back to the vault, and two folders that link to each other.
        symlink("..", root.join("Projects/up")).unwrap();
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        symlink("../b", root.join("a/to-b")).unwrap();
        symlink("../a", root.join("b/to-a")).unwrap();

        // A linked folder is listed as a folder with what is in it, and the walk ends.
        let tree = vault.tree().unwrap();
        let folder = |name: &str| tree.iter().find(|e| e.name == name).unwrap().children.as_ref().unwrap();
        assert_eq!(tree.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["a", "b", "Projects", "Work", "alias.md", "apple.md", "Home.md"]);
        assert_eq!(folder("Work").iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["Work/inklode.md"]);
        assert_eq!(folder("Projects").iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["Projects/inklode.md"]);
        assert_eq!(folder("a")[0].path, "a/to-b");
        assert_eq!(folder("a")[0].children.as_deref(), Some(&[][..]));
        assert!(vault.is_folder("Work") && !vault.is_folder("alias.md"));
        let index = crate::index::Index::build(&vault).unwrap();
        assert_eq!(index.search("notes").iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(), ["Projects/inklode.md", "Work/inklode.md", "alias.md"]);

        // Reading and writing go to the file the link points to, and the link stays a link.
        assert_eq!(vault.read("alias.md").unwrap(), "notes");
        vault.write("alias.md", "through the link").unwrap();
        assert!(fs::symlink_metadata(root.join("alias.md")).unwrap().is_symlink());
        assert_eq!(fs::read_to_string(root.join("Projects/inklode.md")).unwrap(), "through the link");
        assert!(matches!(vault.write_over("Work/inklode.md", "x", Some("stale")), Err(Error::Conflict(_))));
        vault.write_over("Work/inklode.md", "by the folder link", Some("through the link")).unwrap();
        assert_eq!(vault.read("alias.md").unwrap(), "by the folder link");
        vault.create("Work/new.md", "made").unwrap();
        assert_eq!(fs::read_to_string(root.join("Projects/new.md")).unwrap(), "made");
        assert!(matches!(vault.create("alias.md", ""), Err(Error::Exists(_))));

        // A rename moves the link itself, and what it points to stays where it is.
        vault.rename("alias.md", "a/alias.md").unwrap();
        assert!(fs::symlink_metadata(root.join("a/alias.md")).unwrap().is_symlink());
        assert_eq!(fs::read_to_string(root.join("Projects/inklode.md")).unwrap(), "by the folder link");
    }

    #[test]
    fn open_fails_on_a_file() {
        let (dir, _vault) = sample();
        assert!(matches!(
            Vault::open(dir.path().join("Home.md")),
            Err(Error::NotAFolder(_))
        ));
    }
}
