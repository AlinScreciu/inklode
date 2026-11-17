//! The MCP tools over a Inklode vault, shared by the two servers that offer them:
//! the headless `inklode-mcp` binary (stdio) and the desktop app (HTTP, see `src-tauri/src/mcp.rs`).

use std::sync::Mutex;

use inklode_core::Core;
use rmcp::model::{CallToolResult, ContentBlock, Tool};
use serde_json::{Value, json};

struct ToolDef {
    /// The MCP tool name.
    name: &'static str,
    /// The `Core::call` name it maps to. The tool's arguments are passed on unchanged, except `own` (see `call`).
    call: &'static str,
    description: &'static str,
    /// `(name, description)` of each parameter. All are strings, and required
    /// unless the description starts with `Optional`.
    params: &'static [(&'static str, &'static str)],
}

const NOTE_PATH: &str = "Path of the note, relative to the vault root, with forward slashes, e.g. `Projects/Plan.md`. Paths with a part that starts with a dot (`.git`, `.inklode`, `.trash`) are refused.";

/// Every core tool. To expose another `Core::call`, add a row.
const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "search",
        call: "search",
        description: "Finds notes whose file name or text contains the query, ignoring case; returns at most 200 hits as {path, line, text}, where line 0 is a file-name match.",
        params: &[("query", "Text to look for.")],
    },
    ToolDef {
        name: "read",
        call: "note.read",
        description: "Returns the full Markdown text of one note as {content}.",
        params: &[("path", NOTE_PATH)],
    },
    ToolDef {
        name: "write",
        call: "note.write",
        description: "Creates a note or replaces its whole content, creating missing folders. Pass `base` to replace a note you read, so a change made since then is not lost.",
        params: &[
            ("path", NOTE_PATH),
            ("content", "The complete new Markdown text of the note."),
            ("base", "Optional. The note's text as you last read it. If the file no longer holds exactly this, nothing is written and the error starts with `changed on disk since it was read`; read the note again and redo the change."),
        ],
    },
    ToolDef {
        name: "create",
        call: "note.create",
        description: "Makes a new note, creating missing folders. Fails with `already exists` if anything has that path, so it never replaces a note.",
        params: &[("path", NOTE_PATH), ("content", "Optional. The Markdown text of the new note; empty if left out.")],
    },
    ToolDef {
        name: "rename",
        call: "note.rename",
        description: "Moves or renames a note and rewrites the links that point to it; returns {updated}, the notes whose links were rewritten.",
        params: &[
            ("from", "Current path of the note, relative to the vault root, with forward slashes."),
            ("to", "New path of the note, relative to the vault root, with forward slashes. It must not exist yet."),
        ],
    },
    ToolDef {
        name: "delete",
        call: "note.delete",
        description: "Deletes a note by moving it to `.trash/` in the vault; returns {trashed}, where it is now. Links to it stay as they are.",
        params: &[("path", NOTE_PATH)],
    },
    ToolDef {
        name: "folder_rename",
        call: "folder.rename",
        description: "Moves or renames a folder with everything in it and rewrites the links that would break; returns {updated}, the notes outside it whose links were rewritten.",
        params: &[
            ("from", "Current path of the folder, relative to the vault root, with forward slashes."),
            ("to", "New path of the folder. It must not exist yet and cannot be inside the folder itself."),
        ],
    },
    ToolDef {
        name: "folder_delete",
        call: "folder.delete",
        description: "Deletes a folder with everything in it by moving it to `.trash/` in the vault; returns {trashed}, where it is now.",
        params: &[("path", "Path of the folder, relative to the vault root, with forward slashes.")],
    },
    ToolDef {
        name: "folder_new",
        call: "folder.new",
        description: "Makes an empty folder, and the folders above it. Fails if the path is taken.",
        params: &[("path", "Path of the new folder, relative to the vault root, with forward slashes.")],
    },
    ToolDef {
        name: "list",
        call: "vault.tree",
        description: "Returns the vault's folders and files as a tree of {name, path, children}.",
        params: &[],
    },
    ToolDef {
        name: "backlinks",
        call: "note.backlinks",
        description: "Lists the lines in other notes that link to this note, as {path, line, text}.",
        params: &[("path", NOTE_PATH)],
    },
    ToolDef {
        name: "resolve",
        call: "note.resolve",
        description: "Finds the note a wiki link points to; returns {path}, which is null when no note matches.",
        params: &[
            ("link", "The link target as written between `[[` and `]]`, e.g. `Plan#Goals`."),
            ("from", "Path of the note that contains the link, relative to the vault root, with forward slashes."),
        ],
    },
    ToolDef {
        name: "git_log",
        call: "git.log",
        description: "Lists the git commits that changed a note, newest first and through renames, as {rev, author, date, subject}. Empty when the vault is not in a git repository or the note was never committed.",
        params: &[("path", NOTE_PATH)],
    },
    ToolDef {
        name: "git_show",
        call: "git.show",
        description: "Returns a note's text in a git commit as {content}, which is null when there is no such version. Reads only; the note on disk is not changed.",
        params: &[("path", NOTE_PATH), ("rev", "Optional. The commit's hash, as `git_log` gives it. Left out, the last commit.")],
    },
    ToolDef {
        name: "git_blame",
        call: "git.blame",
        description: "Says which git commit last changed each part of a note as last committed: a list of {from, to, rev, author, date, subject}, where from and to are line numbers from 1, inclusive.",
        params: &[("path", NOTE_PATH)],
    },
    ToolDef {
        name: "review_list",
        call: "review.list",
        description: "Lists the notes that wait for the user's review as {repository, entries}: those whose text changed since the user last looked, by git, each {path, status, added, removed, commits, uncommitted} with status `changed`, `added` or `deleted`. `repository` is false when the vault is not in a git repository. Reads only; accepting and rejecting is done by the user in the app.",
        params: &[],
    },
    ToolDef {
        name: "health",
        call: "vault.health",
        description: "Lists what in the vault needs looking after, as {broken, orphans, stale, unchecked}. `broken`: notes with links or embeds that reach no note and no file, each {path, links: [{line, link, text}]}. `orphans`: paths of notes with no link to another note and none from one. `stale`: {path, updated, repo, dir, commits, newest: {date, rev, subject}} for a note whose frontmatter `repos:` names a git repository with commits dated after the note's `updated:` day. `unchecked`: {path, repo, reason} where that could not be checked. Reads only, and fetches nothing.",
        params: &[],
    },
    ToolDef {
        name: "tasks",
        call: "vault.tasks",
        description: "Lists the open checkboxes (`- [ ]`) of every note, outside code fences, as a list of {path, tasks: [{line, text}]} with line numbers from 1. Reads only; to tick one, write the note with that line's `[ ]` changed to `[x]`.",
        params: &[],
    },
    // `claims.check` gets no row: it can run a command a note names, which only the user starts, in the app.
    ToolDef {
        name: "claims_list",
        call: "claims.list",
        description: "Lists the claims of every note: lines that end with `<!-- check: … -->`, outside code, where the comment names the evidence as `file <path>`, a URL, or a shell command with an optional ` @ <folder>`. Returns [{path, line, text, evidence, kind, status, checked, output}] by path then line: `kind` is `command`, `file` or `url`; `status` is `unchecked`, `failing`, `stale` (passed more than 30 days ago, or the file changed since) or `passing`; `checked` is the day of the last check or null, `output` what it printed or why it failed, or null. Reads only: runs no command and fetches no URL. Checks are run by the user in the app.",
        params: &[],
    },
];

impl ToolDef {
    fn tool(&self) -> Tool {
        let properties: serde_json::Map<String, Value> = self
            .params
            .iter()
            .map(|(name, description)| (name.to_string(), json!({ "type": "string", "description": description })))
            .collect();
        let required: Vec<&str> = self.params.iter().filter(|(_, description)| !description.starts_with("Optional")).map(|(name, _)| *name).collect();
        let schema = json!({ "type": "object", "properties": properties, "required": required });
        Tool::new(self.name, self.description, rmcp::model::object(schema))
    }
}

/// The core tools, as listed to an MCP client.
pub fn tools() -> Vec<Tool> {
    TOOLS.iter().map(ToolDef::tool).collect()
}

/// Runs the core tool `name` with `params` on `core`. `None` if there is no core tool of that name.
/// A core error is a tool error that carries the core's message.
///
/// Blocks while the core works, so a server with concurrent clients calls it off the async runtime.
pub fn call(core: &Mutex<Core>, name: &str, mut params: Value) -> Option<CallToolResult> {
    let def = TOOLS.iter().find(|def| def.name == name)?;
    // `own` tells the core that the user did this in the app, which keeps it out of the user's
    // review inbox. That is not for a client to say, so it is the one argument not passed on.
    if let Some(arguments) = params.as_object_mut() {
        arguments.remove("own");
    }
    Some(match core.lock().unwrap().call(def.call, params) {
        Ok(value) => CallToolResult::success(vec![ContentBlock::text(value.to_string())]),
        Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_are_listed_and_no_tool_checks_one() {
        let (dir, state, marks) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mark = marks.path().join("ran");
        std::fs::write(dir.path().join("a.md"), format!("Runs. <!-- check: touch {} -->\n", mark.display())).unwrap();
        let mut core = Core::new();
        core.set_state_dir(state.path());
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        let core = Mutex::new(core);

        let listed = serde_json::to_value(call(&core, "claims_list", json!({})).unwrap()).unwrap();
        let listed: Value = serde_json::from_str(listed["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!((&listed[0]["path"], &listed[0]["line"], &listed[0]["kind"], &listed[0]["status"]), (&json!("a.md"), &json!(1), &json!("command"), &json!("unchecked")));

        assert!(TOOLS.iter().all(|def| def.call != "claims.check"));
        for name in ["claims_check", "claims.check", "check"] {
            assert!(call(&core, name, json!({ "path": "a.md", "line": 1, "commands": true })).is_none(), "{name}");
        }
        assert!(!mark.exists());
    }

    #[test]
    fn a_client_cannot_say_that_the_user_did_it() {
        let git = |dir: &std::path::Path, args: &[&str]| {
            let config = ["-c", "user.name=Ana", "-c", "user.email=ana@example.com", "-c", "commit.gpgsign=false"];
            std::process::Command::new("git").current_dir(dir).args(config).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").output().is_ok_and(|out| out.status.success())
        };
        let (dir, state) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::write(dir.path().join("a.md"), "one\n").unwrap();
        if !(git(dir.path(), &["init", "-q"]) && git(dir.path(), &["add", "-A"]) && git(dir.path(), &["commit", "-q", "-m", "first"])) {
            return;
        }
        let mut core = Core::new();
        core.set_state_dir(state.path());
        core.call("vault.open", json!({ "path": dir.path() })).unwrap();
        let core = Mutex::new(core);
        let text = |name: &str, params: Value| serde_json::to_value(call(&core, name, params).unwrap()).unwrap()["content"][0]["text"].as_str().unwrap().to_string();
        assert_eq!(text("review_list", json!({})), r#"{"entries":[],"repository":true}"#);

        // With `own` the core would accept the deletion for the user. The tool does not pass it on, so it waits.
        text("delete", json!({ "path": "a.md", "own": true }));
        let waiting: Value = serde_json::from_str(&text("review_list", json!({}))).unwrap();
        assert_eq!(waiting["entries"][0]["path"], "a.md");
        assert_eq!(waiting["entries"][0]["status"], "deleted");
    }
}
