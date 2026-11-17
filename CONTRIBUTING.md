# Contributing

Inklode is at version 0.1.0 and has one author. Bug reports and small, focused pull requests are welcome. For a larger change, open an issue first so the direction is agreed before you write it.

## Build and test

Prerequisites and the build commands are in the [README](README.md#build-from-source). Before you open a pull request, these must pass:

```sh
cargo test --workspace
pnpm build
for s in $(node -e 'console.log(Object.keys(require("./package.json").scripts).filter(s=>s.startsWith("test:")).join(" "))'); do pnpm run "$s" || break; done
```

The last line runs every `test:*` script of `package.json`. CI runs the same on macOS.

For a change to the UI, also look at it in the running app (`pnpm tauri dev`), and say in the pull request what you checked.

## Rules for changes

- **A feature is a module behind a flag.** Anything beyond the base app (editor, file tree, links, search, palette, settings) goes in `src/modules/<id>/`, is registered in `MODULES` in `src/modules.ts`, and is off by default. See "How modules work" in [docs/modules.md](docs/modules.md#how-modules-work).
- A core operation gets a Rust test, and its case in `src/core/mock.ts`. Pure UI logic gets a `*.test.mjs` self-check wired into `package.json`.
- A deliberate simplification is marked `// shortcut: <the limit>, <when to upgrade>`.
- Update the page in `docs/` for the area you change: commands, `ui_state` entries and known limits are listed there.
- The safety rules in [AGENTS.md](AGENTS.md#safety-rules) apply to everyone, not only to agents. A pull request that weakens one needs its own discussion first.
- Commits: a short subject that says what changed. No AI attribution lines.

## The slideshow and the AGPL

Inklode reads the drawing files and the slideshow data of the Obsidian Excalidraw plugin, which is licensed under AGPL-3.0. Inklode is MIT and contains none of that plugin's code. The slideshow is implemented from [docs/slideshow-spec.md](docs/slideshow-spec.md) alone.

Do not copy or port code from the plugin or its scripts, and do not write slideshow code with the plugin's source open. If the spec lacks something, describe the behaviour or the file content in the spec first, then implement from the spec.

## Bug reports

Use the bug report template. A good report has:

- The Inklode version or commit, the operating system and its version, and the chip (Apple Silicon or Intel).
- Which modules are on (Settings, "Modules").
- The smallest note or vault that shows the problem, as text. Remove anything private.
- What you did, what you expected, and what happened, including the text of the error banner.
- Whether the vault is in a git repository, for anything about history, review or health.

Report security problems privately, as [SECURITY.md](SECURITY.md) says, not in an issue.

## Licence

Contributions are accepted under the MIT licence of the project ([LICENSE](LICENSE)). By opening a pull request you confirm that you wrote the change, or have the right to submit it under that licence.
