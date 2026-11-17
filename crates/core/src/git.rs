//! The vault's git history, read by running the `git` binary. Only `log`, `cat-file`, `show -s`
//! and `blame` of a commit are run here, and review.rs and health.rs run their own read-only
//! commands through `git`: nothing writes to the repository or the work tree.
//!
//! The repository may come from someone else, and its config can name programs for git to
//! run. Two rules keep that from happening:
//! - every git process of the core is made by `command`, which switches those settings off;
//! - git is never asked to read a file of the work tree (`diff`, `status`, `blame` without a
//!   commit, `hash-object <file>`), because that runs the clean, process and textconv programs
//!   `.gitattributes` and the config name. Committed text is read with `cat-file`, which
//!   applies none, the file on disk is read by our own code, and review.rs compares the two.
//!
//! A vault that is not in a git repository, a missing `git`, and a file git does not
//! know all give an empty answer, never an error: history is an extra, not a need.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Commit {
    pub rev: String,
    pub author: String,
    /// The author date, ISO 8601 with the author's offset: `2026-11-16T21:04:33+02:00`.
    pub date: String,
    pub subject: String,
}

/// Lines `from` to `to` (1-based, inclusive) of the committed file were last changed by `commit`.
#[derive(Serialize, Debug, PartialEq)]
pub struct BlameRange {
    pub from: usize,
    pub to: usize,
    #[serde(flatten)]
    pub commit: Commit,
}

/// One record per commit: a record separator, then the fields, each ended by a unit separator.
pub(crate) const FORMAT: &str = "--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f";

/// Settings given to every git process on its command line, where they win over the
/// repository's config. Each one names a way a config can make git run a program or reach
/// the network, and switches it off.
const HARDENED: &[&str] = &[
    // A folder with `HEAD`, `config`, `refs/` and `objects/` in it is not taken for a repository.
    "safe.bareRepository=explicit",
    // No transport: a remote's `uploadpack`, `core.sshCommand` and `core.gitProxy` are never reached.
    // The config can still allow one protocol by name (`protocol.ext.allow`), which
    // `GIT_ALLOW_PROTOCOL` in `command` overrules.
    "protocol.allow=never",
    "core.sshCommand=false",
    "core.gitProxy=",
    "credential.helper=",
    "core.askPass=",
    // No signature is checked, and there is no program to check one with.
    "log.showSignature=false",
    "gpg.program=/dev/null",
    "gpg.ssh.program=/dev/null",
    "gpg.x509.program=/dev/null",
    "core.fsmonitor=false",
    "core.hooksPath=/dev/null",
    "core.pager=cat",
    "core.editor=false",
    "diff.external=",
    "submodule.recurse=false",
];

/// `git`, to run in the folder `root`. Every git process of the core is made here.
fn command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).arg("--no-pager");
    for setting in HARDENED {
        command.args(["-c", setting]);
    }
    command
        // A missing object of a partial clone is not fetched: fetching runs the remote's `uploadpack`.
        .env("GIT_NO_LAZY_FETCH", "1")
        // The list of allowed protocols, empty: it wins over every `protocol.<name>.allow` of the config.
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Only the repository's own config is read, under the settings above. The user's
        // `safe.directory` and global ignore file are with that not read either.
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        // Reading must not take the index lock, which a commit running elsewhere needs.
        .env("GIT_OPTIONAL_LOCKS", "0");
    command
}

/// What `git <args>` prints, run in the folder `root`. `None` when it cannot run or fails.
pub(crate) fn git(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = command(root).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    output.status.success().then_some(output.stdout)
}

/// The bytes of the objects named by `ids` (hashes), as committed: one `cat-file --batch`
/// run, which applies no filter and no conversion. An object the repository does not have
/// is `None`. All of it is `None` when git cannot run.
pub(crate) fn blobs(root: &Path, ids: &[&str]) -> Option<Vec<Option<Vec<u8>>>> {
    if ids.is_empty() {
        return Some(Vec::new());
    }
    let mut child = command(root).args(["cat-file", "--batch"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let asked = ids.join("\n") + "\n";
    // Written from a thread of its own: git answers while it reads, and both pipes are of limited size.
    let writer = std::thread::spawn(move || drop(stdin.write_all(asked.as_bytes())));
    let output = child.wait_with_output().ok()?;
    let _ = writer.join();
    // Per object `<hash> <type> <size>\n<bytes>\n`, or `<name> missing\n`.
    let mut rest = output.stdout.as_slice();
    let mut found = Vec::with_capacity(ids.len());
    for _ in ids {
        let end = rest.iter().position(|byte| *byte == b'\n')?;
        let header = std::str::from_utf8(&rest[..end]).ok()?;
        rest = &rest[end + 1..];
        if header.ends_with(" missing") {
            found.push(None);
            continue;
        }
        let size: usize = header.rsplit(' ').next()?.parse().ok()?;
        found.push(Some(rest.get(..size)?.to_vec()));
        rest = rest.get(size + 1..)?;
    }
    Some(found)
}

/// The commits in output made with `FORMAT`, each with what git printed after it
/// (the names of the files it changed, with `--name-only -z`).
pub(crate) fn commits(output: &[u8]) -> Vec<(Commit, Vec<String>)> {
    String::from_utf8_lossy(output)
        .split('\x1e')
        .filter_map(|record| {
            let mut fields = record.split('\x1f');
            let mut field = || fields.next().map(str::to_string);
            let commit = Commit { rev: field()?, author: field()?, date: field()?, subject: field()? };
            let rest = field()?;
            let names = rest.split('\0').map(|name| name.trim_matches('\n')).filter(|name| !name.is_empty());
            Some((commit, names.map(str::to_string).collect()))
        })
        .collect()
}

/// The commits that changed the file, newest first, each with the path the file had in
/// it, relative to the vault. Renames are followed.
fn history(root: &Path, path: &str) -> Vec<(Commit, String)> {
    // `--relative`: names as seen from the vault's folder, which need not be the repository's root.
    let listed = git(root, &["log", "--follow", "-z", "--name-only", "--relative", FORMAT, "--", path]).map(|out| commits(&out));
    // `--follow` takes one file, so each commit names one.
    listed.unwrap_or_default().into_iter().map(|(commit, names)| (commit, names.into_iter().next().unwrap_or_default())).collect()
}

pub fn log(root: &Path, path: &str) -> Vec<Commit> {
    history(root, path).into_iter().map(|(commit, _)| commit).collect()
}

/// The file's text in the commit `rev` (a hex hash, checked by the caller), or in the last
/// commit of the branch without one. `None` when there is no such version, or it is not text.
pub fn show(root: &Path, path: &str, rev: Option<&str>) -> Option<String> {
    let object = match rev {
        None => format!("HEAD:./{path}"),
        Some(rev) => {
            // The file may have had another name in that commit.
            let then = history(root, path).into_iter().find(|(commit, _)| commit.rev.starts_with(rev)).map(|(_, name)| name);
            format!("{rev}:./{}", then.as_deref().unwrap_or(path))
        }
    };
    // `cat-file blob`: the bytes as committed, with no filter or conversion from the repository's config.
    String::from_utf8(git(root, &["cat-file", "blob", &object])?).ok()
}

/// Who last changed each line of the file as it is in the last commit. Uncommitted
/// changes are not in it. Consecutive lines of one commit are one range.
pub fn blame(root: &Path, path: &str) -> Vec<BlameRange> {
    let Some(output) = git(root, &["blame", "--porcelain", "--no-textconv", "HEAD", "--", path]) else {
        return Vec::new();
    };
    // A line of the file starts with a tab. Before it comes `<hash> <line then> <line now> [<count>]`,
    // and other lines that start with a word (`author`, `summary`, `previous`).
    let mut runs: Vec<(usize, usize, String)> = Vec::new();
    for line in String::from_utf8_lossy(&output).lines() {
        let mut parts = line.split(' ');
        let (Some(rev), Some(_), Some(now)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let Ok(now) = now.parse::<usize>() else { continue };
        if rev.len() < 40 || !rev.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        match runs.last_mut() {
            Some((_, to, last)) if last == rev && *to + 1 == now => *to = now,
            _ => runs.push((now, now, rev.to_string())),
        }
    }
    if runs.is_empty() {
        return Vec::new();
    }
    // The porcelain format gives dates as seconds and an offset. One more call gets them, and
    // the rest, in the form `log` has.
    let mut revs: Vec<&str> = runs.iter().map(|(_, _, rev)| rev.as_str()).collect();
    revs.sort_unstable();
    revs.dedup();
    let mut args = vec!["show", "-s", FORMAT];
    args.extend(&revs);
    args.push("--");
    let known: Vec<Commit> = git(root, &args).map(|out| commits(&out)).unwrap_or_default().into_iter().map(|(commit, _)| commit).collect();
    runs.into_iter()
        .filter_map(|(from, to, rev)| Some(BlameRange { from, to, commit: known.iter().find(|commit| commit.rev == rev)?.clone() }))
        .collect()
}

/// A repository from someone else must not get a program run: the review's attacks, and
/// the other ways a config can name a program. Each one would leave a file in `marks`.
#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use serde_json::{Value, json};

    use crate::Core;

    /// Runs a shell script in `dir` as the one who prepares the repository: plain git, with `$M` the marks folder.
    fn sh(dir: &Path, marks: &Path, script: &str) {
        let script = format!("set -eu\n{script}");
        let run = Command::new("/bin/sh").arg("-c").arg(&script).current_dir(dir).env("M", marks).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
        assert!(run.status.success(), "{script}\n{}", String::from_utf8_lossy(&run.stderr));
    }

    /// What plain `git <args>` does in `dir`, to show that an attack is live without the settings of `command`.
    fn plain(dir: &Path, args: &[&str]) {
        let _ = Command::new("git").current_dir(dir).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").env_remove("GIT_NO_LAZY_FETCH").output();
    }

    fn fired(marks: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(marks).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn clear(marks: &Path) {
        for name in fired(marks) {
            fs::remove_file(marks.join(name)).unwrap();
        }
    }

    /// Every operation of the core that runs git, on the vault at `vault`.
    fn every_operation(vault: &Path) {
        let state = tempfile::tempdir().unwrap();
        let mut core = Core::new();
        core.set_state_dir(state.path());
        core.call("vault.open", json!({ "path": vault })).unwrap();
        let notes: Vec<String> = core.call("vault.tree", Value::Null).unwrap().as_array().unwrap().iter().filter_map(|entry| entry["path"].as_str().map(str::to_string)).filter(|path| path.ends_with(".md")).collect();
        for _ in 0..2 {
            for note in &notes {
                let log = core.call("git.log", json!({ "path": note })).unwrap();
                core.call("git.show", json!({ "path": note })).unwrap();
                if let Some(rev) = log[0]["rev"].as_str() {
                    core.call("git.show", json!({ "path": note, "rev": rev })).unwrap();
                }
                core.call("git.blame", json!({ "path": note })).unwrap();
                core.call("review.base", json!({ "path": note })).unwrap();
                core.call("review.saved", json!({ "path": note, "before": "one\n", "after": "one\ntwo\n" })).unwrap();
                core.call("review.accept", json!({ "path": note })).unwrap();
            }
            core.call("review.list", Value::Null).unwrap();
            core.call("vault.health", Value::Null).unwrap();
            // The second round is with a change on disk and after an "accept all".
            if let Some(note) = notes.first() {
                core.call("note.write", json!({ "path": note, "content": "changed\non disk\n" })).unwrap();
            }
            core.call("review.accept", json!({})).unwrap();
        }
    }

    /// A repository with one commit of `a.md` and a change to it on disk.
    const REPO: &str = "git init -q .\ngit config user.name a\ngit config user.email a@b\nprintf 'one\\n' > a.md\ngit add -A\ngit commit -qm first\nprintf 'two\\n' >> a.md\n";

    /// A second commit that carries a signature, and a config that checks signatures with a program.
    const SIGNED: &str = "printf '#!/bin/sh\\ntouch %s/gpg\\nexit 1\\n' \"$M\" > \"$M/../fakegpg\"\nchmod +x \"$M/../fakegpg\"\n\
        P=$(git rev-parse HEAD)\ngit add a.md\nT=$(git write-tree)\n\
        C=$(printf 'tree %s\\nparent %s\\nauthor a <a@b> 1700000000 +0000\\ncommitter a <a@b> 1700000000 +0000\\ngpgsig -----BEGIN PGP SIGNATURE-----\\n \\n iQEzBAABCAAdFiEE\\n -----END PGP SIGNATURE-----\\n\\nsigned\\n' \"$T\" \"$P\" | git hash-object -t commit -w --stdin)\n\
        git reset -q --hard \"$C\"\nprintf 'three\\n' >> a.md\n\
        git config log.showSignature true\ngit config gpg.program \"$M/../fakegpg\"\ngit config gpg.openpgp.program \"$M/../fakegpg\"\ngit config gpg.ssh.program \"$M/../fakegpg\"\ngit config gpg.x509.program \"$M/../fakegpg\"\n";

    /// The blob of `a.md` taken out of the repository, which is made a partial clone whose remote runs a command.
    const PROMISOR: &str = "B=$(git rev-parse HEAD:a.md)\nrm \".git/objects/$(echo \"$B\" | cut -c1-2)/$(echo \"$B\" | cut -c3-)\"\n\
        git config core.repositoryFormatVersion 1\ngit config extensions.partialClone origin\ngit config remote.origin.promisor true\n\
        git config remote.origin.partialclonefilter blob:none\n";

    fn dirs() -> Option<(tempfile::TempDir, PathBuf, PathBuf)> {
        if Command::new("git").arg("--version").output().is_err() {
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let (marks, vault) = (dir.path().join("marks"), dir.path().join("vault"));
        fs::create_dir_all(&marks).unwrap();
        fs::create_dir_all(&vault).unwrap();
        Some((dir, marks, vault))
    }

    #[test]
    fn filters_drivers_hooks_aliases_and_included_config_run_nothing() {
        let Some((_dir, marks, vault)) = dirs() else { return };
        sh(&vault, &marks, REPO);
        sh(
            &vault,
            &marks,
            "printf '*.md filter=evil diff=evil merge=evil\\n' > .gitattributes\n\
             git config filter.evil.clean \"touch $M/filter-clean; cat\"\n\
             git config filter.evil.smudge \"touch $M/filter-smudge; cat\"\n\
             git config filter.evil.process \"touch $M/filter-process; false\"\n\
             git config diff.evil.textconv \"touch $M/textconv; cat\"\n\
             git config diff.evil.command \"touch $M/diff-driver;\"\n\
             git config merge.evil.driver \"touch $M/merge-driver;\"\n\
             git config diff.external \"touch $M/diff-external;\"\n\
             git config core.fsmonitor \"touch $M/fsmonitor; false\"\n\
             git config core.pager \"touch $M/pager; cat\"\n\
             git config pager.log true\ngit config pager.blame true\ngit config pager.show true\ngit config pager.cat-file true\n\
             git config core.editor \"touch $M/editor;\"\n\
             git config sequence.editor \"touch $M/editor;\"\n\
             git config core.sshCommand \"touch $M/ssh;\"\n\
             git config core.gitProxy \"touch $M/proxy;\"\n\
             git config core.askPass \"touch $M/askpass;\"\n\
             git config credential.helper \"!touch $M/credential;\"\n\
             git config core.alternateRefsCommand \"touch $M/alternate-refs;\"\n\
             for c in log show blame cat-file ls-tree ls-files rev-parse diff status; do git config \"alias.$c\" \"!touch $M/alias\"; done\n\
             mkdir hooks-elsewhere\n\
             for h in post-index-change reference-transaction pre-auto-gc post-checkout post-commit pre-commit fsmonitor-watchman post-merge; do\n\
               for d in .git/hooks hooks-elsewhere; do printf '#!/bin/sh\\ntouch %s/hook\\n' \"$M\" > \"$d/$h\"; chmod +x \"$d/$h\"; done\n\
             done\n\
             git config core.hooksPath \"$PWD/hooks-elsewhere\"\n\
             printf '[log]\\n\\tshowSignature = true\\n[gpg]\\n\\tprogram = touch %s/included-gpg;\\n[core]\\n\\tfsmonitor = touch %s/included-fsmonitor; false\\n' \"$M\" \"$M\" > evil.inc\n\
             git config include.path \"$PWD/evil.inc\"\n\
             git config 'includeIf.gitdir:**.path' \"$PWD/evil.inc\"\n",
        );
        // Without the settings of `command`, comparing with the work tree runs the filter.
        plain(&vault, &["diff", "HEAD"]);
        assert!(fired(&marks).iter().any(|name| name.starts_with("filter-")), "the attack is not live: {:?}", fired(&marks));
        clear(&marks);

        every_operation(&vault);
        assert_eq!(fired(&marks), Vec::<String>::new());
    }

    #[test]
    fn a_signed_commit_is_not_checked_with_the_program_of_the_config() {
        let Some((_dir, marks, vault)) = dirs() else { return };
        sh(&vault, &marks, REPO);
        sh(&vault, &marks, SIGNED);
        plain(&vault, &["log"]);
        assert_eq!(fired(&marks), ["gpg"], "the attack is not live");
        clear(&marks);

        every_operation(&vault);
        assert_eq!(fired(&marks), Vec::<String>::new());
    }

    #[test]
    fn a_missing_object_is_not_fetched_from_a_remote_that_names_a_command() {
        let Some((dir, marks, vault)) = dirs() else { return };
        // The same attack through each kind of remote: a folder with `uploadpack`, the `ext` transport, and ssh.
        let remotes = [
            ("folder", format!("git config remote.origin.url \"{}\"\ngit config remote.origin.uploadpack \"touch $M/uploadpack; false\"\n", vault.display())),
            ("ext", "git config remote.origin.url \"ext::sh -c touch% $M/ext\"\ngit config protocol.ext.allow always\n".to_string()),
            ("ssh", "git config remote.origin.url ssh://nowhere.invalid/x.git\ngit config core.sshCommand \"touch $M/ssh; false\"\ngit config remote.origin.vcs \"\" || true\n".to_string()),
        ];
        for (name, remote) in remotes {
            let vault = dir.path().join(name);
            fs::create_dir_all(&vault).unwrap();
            sh(&vault, &marks, REPO);
            sh(&vault, &marks, PROMISOR);
            sh(&vault, &marks, &remote);
            if name == "folder" {
                plain(&vault, &["cat-file", "blob", "HEAD:a.md"]);
                assert_eq!(fired(&marks), ["uploadpack"], "the attack is not live");
                clear(&marks);
            }
            every_operation(&vault);
            assert_eq!(fired(&marks), Vec::<String>::new(), "{name}");
            // The same without the variable that newer versions of git have for this.
            let cat = super::command(&vault).env_remove("GIT_NO_LAZY_FETCH").args(["cat-file", "blob", "HEAD:a.md"]).output().unwrap();
            assert!(!cat.status.success(), "{name}");
            assert_eq!(fired(&marks), Vec::<String>::new(), "{name} without GIT_NO_LAZY_FETCH");
        }
    }

    #[test]
    fn a_vault_that_looks_like_a_bare_repository_is_not_taken_for_one() {
        let Some((dir, marks, vault)) = dirs() else { return };
        let source = dir.path().join("source");
        fs::create_dir_all(&source).unwrap();
        sh(&source, &marks, REPO);
        sh(&source, &marks, SIGNED);
        // The vault's top level is the inside of a repository: `HEAD`, `config`, `refs/`, `objects/`.
        sh(
            dir.path(),
            &marks,
            "git clone -q --bare source bare.git\ncp -R bare.git/. vault/\ncd vault\nprintf '# Welcome\\n' > Welcome.md\n\
             git config log.showSignature true\ngit config gpg.program \"$M/../fakegpg\"\n\
             git config core.fsmonitor \"touch $M/fsmonitor; false\"\n\
             git config core.repositoryFormatVersion 1\ngit config extensions.partialClone origin\ngit config remote.origin.promisor true\n\
             git config remote.origin.url \"$PWD\"\ngit config remote.origin.uploadpack \"touch $M/uploadpack; false\"\n",
        );
        plain(&vault, &["log"]);
        assert_eq!(fired(&marks), ["gpg"], "the attack is not live");
        clear(&marks);

        every_operation(&vault);
        assert_eq!(fired(&marks), Vec::<String>::new());
        assert!(super::git(&vault, &["rev-parse", "--git-dir"]).is_none());
    }

    #[test]
    fn health_follows_a_repos_entry_to_a_planted_repository_and_runs_nothing() {
        let Some((dir, marks, vault)) = dirs() else { return };
        let planted = vault.join("sub/planted");
        fs::create_dir_all(&planted).unwrap();
        sh(&planted, &marks, REPO);
        sh(&planted, &marks, SIGNED);
        sh(&planted, &marks, "git config core.fsmonitor \"touch $M/fsmonitor; false\"\n");
        sh(&vault, &marks, "git clone -q --bare sub/planted sub/bare.git\ngit -C sub/bare.git config log.showSignature true\ngit -C sub/bare.git config gpg.program \"$M/../fakegpg\"\n");
        fs::write(vault.join("note.md"), format!("---\nrepos: [{}, {}]\nupdated: 2020-01-01\n---\ntext\n", planted.display(), vault.join("sub/bare.git").display())).unwrap();
        let _ = dir;

        let mut core = Core::new();
        core.call("vault.open", json!({ "path": vault })).unwrap();
        let health = core.call("vault.health", Value::Null).unwrap();
        assert_eq!(fired(&marks), Vec::<String>::new());
        // The repository with a work tree is read, the bare one is not taken for a repository.
        assert_eq!(health["stale"].as_array().unwrap().len(), 1, "{health}");
        assert_eq!(health["stale"][0]["commits"], 2);
        assert_eq!(health["unchecked"][0]["reason"], "not found or not a git repository");
    }

    #[test]
    fn blobs_are_read_as_committed_and_a_missing_one_is_none() {
        let Some((_dir, marks, vault)) = dirs() else { return };
        sh(&vault, &marks, REPO);
        sh(&vault, &marks, "head -c 300000 /dev/urandom > big.bin\nprintf 'no newline' > b.md\n: > empty.md\ngit add -A\ngit commit -qm more\n");
        let hash = |name: &str| String::from_utf8(super::git(&vault, &["rev-parse", &format!("HEAD:{name}")]).unwrap()).unwrap().trim().to_string();
        let (a, b, big, empty) = (hash("a.md"), hash("b.md"), hash("big.bin"), hash("empty.md"));
        let none = "0123456789012345678901234567890123456789";
        // More names than a pipe holds, so writing and reading must go on together.
        let mut ids = vec![a.as_str(), none, b.as_str(), empty.as_str()];
        ids.extend(std::iter::repeat_n(big.as_str(), 40));
        let found = super::blobs(&vault, &ids).unwrap();
        assert_eq!(found[..4], [Some(b"one\ntwo\n".to_vec()), None, Some(b"no newline".to_vec()), Some(Vec::new())]);
        assert!(found[4..].iter().all(|bytes| bytes.as_deref() == Some(fs::read(vault.join("big.bin")).unwrap().as_slice())));
        assert_eq!(super::blobs(&vault, &[]), Some(Vec::new()));
    }
}
