# Security

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: on the repository's GitHub page, open the "Security" tab and choose "Report a vulnerability". Do not open a public issue for it.

Include the version or commit, the steps to reproduce, and what an attacker gains. Inklode has one maintainer and no fixed response time; reports are read and answered as soon as possible. Only the latest version is fixed.

## In scope

- A way to run a claim's command without the user's own click, or in a vault the user did not trust: through an MCP tool, a synthetic event, a key binding, or anything a vault's files can set.
- A way for a vault's content (notes, `.inklode/` files, themes, snippets, drawings) to switch on the MCP server, trust itself for commands, change the app's own settings, or run code.
- A core operation or MCP tool that reads or writes outside the open vault, or reaches a dot path (`.git`, `.inklode`, ...) through `note.*` or `folder.*`.
- A request that the in-app MCP server accepts without its token, or from a web page (the `Origin` and `Host` checks), and any tool or `ui_state` entry that returns the token.
- A repository's config, attributes or hooks making the app's `git` calls run a program or reach the network.
- A page or script from outside the app loaded in a window of the app, or a window navigated away from the app's own page.
- A window other than the main one reaching the vault, the settings or the MCP bridge.

## Known limits, by design

These are documented behaviour, not vulnerabilities. They are also in the README's Security section.

- The MCP server in the app is off by default, listens on `127.0.0.1` only and requires a bearer token on every request. The token is a file in the app's config folder with mode 0600, so any program running as the same user can read it. A client with the token can read and write the open vault, drive the window, and open any folder as a vault (`vault.open {path}`), which reaches every file the user can.
- Claim commands are shell commands taken from note text. They run only on the user's click and only in a vault the user trusted. A program or agent that can write notes can change the command of a claim in a trusted vault, and it runs when the user next checks that claim.
- Trust goes by the vault folder's path, so another vault put at a trusted path is trusted.
- With the MCP server on, `ui_click` and `ui_key` send synthetic events to the window, and it is the window's code that tells them from the user's own (the `isTrusted` flag of the event).
- A URL claim can be checked in a vault that is not trusted. The request goes out from the user's machine, also to addresses only that machine can reach.
- Remote images in notes are loaded from the network when the note is shown.
- The app is not sandboxed: no macOS App Sandbox. The window has a content security policy (scripts, fonts and connections from the app only, no frames; images from the vault, `data:`, `blob:` and https; inline styles allowed). A vault's themes and snippets are CSS that the app loads, and CSS can restyle or hide any part of the window.
- A symlink in a vault that leads to another place in the vault is followed. One that leads out of the vault or to a dot name is refused. The check and the use of a path are two steps, so a program that swaps a folder for a link at that moment is not stopped.
- A `file` claim reads the path it names, also outside the vault and through symlinks: only a regular file, of at most 64 MB.
- With "Check for updates when Inklode starts" on (the default), the app contacts github.com once per start to read the latest version. Nothing about the user or the vault is sent. An update is installed only on the user's click, and only if its archive is signed with the key whose public half is built into the app (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`).
- A claim's command gets the app's environment, with `PATH` taken from the user's login shell at start.

More detail: [docs/claims.md](docs/claims.md) and [docs/mcp.md](docs/mcp.md).
