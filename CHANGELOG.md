# Changelog

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
