# Changelog

## 0.3.1

Fixed:

- Selected text in a note can be read again. While the editor had the focus, CodeMirror's own selection colour, an opaque lavender, was drawn over the text and hid it; 0.3.0 did not fix this.

## 0.3.0

New:

- Built-in theme Things, a port of the Obsidian theme, light and dark.

Fixed:

- Selected text keeps its own colour: links and other text in the accent were hard to read under the selection.
- Vault health and the task list no longer report notes in a `_templates` folder.

## 0.2.0

New:

- Graph options, saved per vault: filters (tags as dots, attachments, link targets that name no note, notes without links), groups that colour the notes matching a query (`path:`, `tag:` or text in the name), display (arrows, when labels appear, dot size, line thickness) and the forces of the layout.
- A local graph in the right sidebar: the open note and the notes within one to three links of it. It follows the note you switch to.
- Three more tools in both MCP servers: `search_ranked` (the notes most relevant to a query, best first), `graph_note` (a note's links, backlinks, unresolved links and the notes near it) and `graph_path` (the shortest chain of links between two notes).
- The app carries the headless MCP server, at `Inklode.app/Contents/MacOS/inklode-mcp`.
- Zoom in, Zoom out and Reset zoom commands for the whole window (Cmd+=, Cmd+-, Cmd+0).

Changed:

- A pinch on the touchpad no longer zooms the whole window. It still zooms the graph and a drawing.
- In the graph, drawings count as attachments and are hidden until "Attachments" is on.

Fixes, found on a vault of 360 notes:

- Two settings saved at the same moment no longer end in "settings.json: No such file or directory" with one of them lost.
- The vault health report no longer keeps notes from opening and saving while it runs, and asks git once per repository instead of once per note.
- The stale check of vault health is stricter about what it counts: a `repos:` name must be a repository's root folder, not a folder inside another repository; only commits on the default branch count; `repo:dir` and `repo:!dir` limit the check to a folder or to everything outside it; commits that only touch `.gitignore`, `.gitattributes`, `.editorconfig`, `.github/CODEOWNERS` or `.pre-commit-config.yaml` do not count.
- In the graph, labels no longer cover each other.

Faster, measured on vaults of 400 and 3000 notes:

- The review inbox and a note's git history no longer keep notes from opening and saving while they are worked out.
- A rename that rewrites the links of many notes is about eight times faster (209 notes: 1.05 s to 0.13 s). Every note is still flushed to disk before it replaces the old one. A note that another program changed during the rename keeps its old links, and the rename says so.
- A new note and a deleted note are looked up in the review inbox alone, not with the whole vault (0.1 s to 0.03 s at 400 notes).
- Vault health remembers a repository's commits until its default branch moves, refreshes three seconds after the last change instead of at every save, and on window focus only while its panel is open.
- A note's backlinks are asked for once, not twice, and the list is built only while it is unfolded.

Releases: the signature the updater checks is now made on the maintainer's Mac and no longer in CI, so GitHub alone cannot ship an update.

## 0.1.3

No new features. Updated dependencies:

- Tauri 2.12.6 and the other Rust crates at their latest compatible versions; `getrandom` 0.4.
- Fixed versions of `nanoid` and `lodash-es` inside Excalidraw, which had security advisories.
- Built with Rust 1.100, TypeScript 7 and pnpm 12.

## 0.1.2

No change to the app. The first version built, signed and notarized by CI from a pushed tag.

## 0.1.1

No change to the app. This version exists to check that an installed 0.1.0 finds, downloads and installs an update.

## 0.1.0

The first public version. Tested on macOS on Apple Silicon only. A signed app for Apple Silicon is attached to the release; elsewhere, build from source.

Base app:

- Opens a folder of Markdown files as a vault; the app's own files are in `.inklode/` inside it.
- Editor on CodeMirror 6 with Live Preview and source mode: GitHub-flavoured Markdown, a properties block for frontmatter, images, task checkboxes, find and replace.
- Wikilinks with aliases and heading links, backlinks, and renames of notes and folders that rewrite links.
- File tree, tabs, split panes, outline, back and forward, quick switcher, command palette, search in all notes.
- Writes that name the text they replace, with a choice (keep mine, take theirs, show both) when a file changed on disk under an unsaved edit. Deletes move to `.trash/`.
- Per-vault themes, CSS snippets and key bindings; built-in themes Catppuccin, Catppuccin Frappé, Catppuccin Macchiato and Minimal; light and dark appearance.

Modules, switched per vault (`excalidraw`, `graph` and `tables` are on by default, the others off):

- `excalidraw`: drawings in the Obsidian Excalidraw plugin's uncompressed format, embeds in notes, and a slideshow over a drawing's frames with build steps and a presenter window.
- `graph`: the graph of notes and links.
- `tables`: pipe tables shown and edited as tables.
- `history`: a note's git history, comparison with a version, restore, and a blame margin.
- `merge`: three-way merge of a change made outside with an unsaved edit.
- `review`: an inbox of notes changed since the user last looked, with accept and reject.
- `health`: broken links, notes without links, and notes stale against the repositories they name.
- `tasks`: the open checkboxes of the vault, with ticking.
- `capture`: quick capture from a system-wide hotkey.
- `claims`: lines that name their evidence (a command, a file or a URL), checked on the user's click, with a review queue and a per-vault trust setting for commands.

MCP:

- `inklode-mcp`, a headless server over stdio for one vault.
- A server in the running app over HTTP on localhost, off by default, with the same vault tools and tools to drive and inspect the window.

Updates:

- The app looks for a newer version on GitHub when it starts (a switch in Settings, About) and on "Check for Updates…" in the app menu. It offers the update in a notice and downloads and installs it only on "Install and restart". The archive is verified against a public key built into the app.
