// In-memory stand-in for the Rust core, used only by `pnpm dev` in a browser.
// It answers the same calls as crates/core/src/call.rs, in simplified form.

import demoDeck from "../modules/excalidraw/fixtures/deck-sorted.excalidraw.md?raw";
import demoDrawing from "../modules/excalidraw/fixtures/diagram.excalidraw.md?raw";

const files = new Map<string, string>([
  // A drawing for the Excalidraw module, as the draw plugin writes it, and a deck with presenter notes and a build.
  ["Drawings/Deck.excalidraw.md", demoDeck],
  ["Drawings/Diagram.excalidraw.md", demoDrawing],
  ["Home.md", "# Home\n\nThe index of this demo vault.\n\n- [[Inklode]]\n- [[Ideas|some ideas]]\n- [ ] a task\n"],
  ["Projects/Inklode.md", "---\ntags: [project]\n---\n# Inklode\n\nA **Markdown** notes app. See [[Home]].\n\n```rust\nfn main() {}\n```\n"],
  ["Projects/Ideas.md", "## Ideas\n\n> Quote\n\n1. One\n2. Two\n\nFor [[Inklode#Inklode]].\n"],
  ["Zettel.md", "Plain text note. Links to [[Home]] and to [[Missing]].\n"],
  // One of every element Live Preview renders (src/components/livePreview.ts).
  [
    "Syntax.md",
    [
      "---",
      "tags: [demo, syntax]",
      "created: 2026-11-16",
      "---",
      "# Heading 1",
      "## Heading 2",
      "### Heading 3",
      "#### Heading 4",
      "##### Heading 5",
      "###### Heading 6",
      "",
      "Text with **bold**, *italic*, ~~strike~~, `inline code` and ***bold italic***.",
      "",
      "Wikilinks: [[Home]], [[Ideas|an alias]], [[Inklode#Inklode]], [[Missing]].",
      "Web links: [CodeMirror](https://codemirror.net) and https://example.com bare.",
      "",
      "- [ ] open task",
      "- [x] done task",
      "- a bullet",
      "  * a nested bullet",
      "1. numbered",
      "",
      "> A quote",
      "> on two lines, with **bold**.",
      "",
      "---",
      "",
      "```js",
      "const answer = 42;",
      "```",
      "",
      "Remote image: ![Placeholder](https://placehold.co/160x60.png)",
      "",
      "![[Attachments/logo.svg]]",
      "",
      "![Local image](Attachments/logo.svg) and a missing one: ![[nope.png]]",
      "",
      "A note embed stays a link: ![[Home]]",
      "",
      "A drawing, shown by the Excalidraw module: ![[Diagram.excalidraw]]",
      "",
      "| Table | Source |",
      "| ----- | ------ |",
      "| stays | as is  |",
      "",
    ].join("\n"),
  ],
  // Vault config (src/config.ts). Not notes: the tree and search leave `.inklode/` out.
  [".inklode/themes/Sepia.css", ":root {\n  --bg: #f4ecd8;\n  --bg-sidebar: #eadfc4;\n  --text: #433422;\n  --accent: #a0522d;\n}\n"],
  [".inklode/themes/Night.css", ":root {\n  --bg: #101418;\n  --bg-sidebar: #161b21;\n  --text: #d7dde4;\n  --accent: #6cb6ff;\n}\n"],
  [".inklode/snippets/Serif text.css", ':root {\n  --font-text: Georgia, "Times New Roman", serif;\n}\n'],
  [".inklode/snippets/Wide lines.css", ":root {\n  --line-width: 60rem;\n}\n"],
]);

/** Files that are not notes, as data URLs. The real app loads these from disk. */
const assets = new Map<string, string>([
  [
    "Attachments/logo.svg",
    "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" rx="10" fill="#6a5acd"/><text x="100" y="50" font-size="28" text-anchor="middle" fill="#fff" font-family="sans-serif">Inklode</text></svg>',
      ),
  ],
]);

/** The URL for a vault-relative file path, or null if there is no such file. */
export const mockAsset = (path: string): string | null => assets.get(path) ?? null;

interface Entry {
  name: string;
  path: string;
  children?: Entry[];
}

interface Hit {
  path: string;
  line: number;
  text: string;
}

type Handler = (event: { type: string; paths: string[] }) => void;
const handlers = new Set<Handler>();

/** Subscribes to the mock's `vault.changed` and `config.changed` events. Returns the unsubscribe function. */
export function mockOnEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Like the real core, reports changes a little after they happen, including the app's own writes. */
function changed(...paths: string[]) {
  const type = paths[0].startsWith(".inklode/") ? "config.changed" : "vault.changed";
  setTimeout(() => handlers.forEach((h) => h({ type, paths })), 100);
}

/** Folders made with `folder.new`. The other folders exist because a file is in them. */
// shortcut: a folder whose last file moves away disappears in the mock; the real core keeps it, empty.
const folders = new Set<string>();

function tree(): Entry[] {
  const root: Entry[] = [];
  // A folder is listed as `Folder/`, so its last part is empty and makes no file.
  for (const path of [...files.keys(), ...[...folders].map((f) => f + "/")].sort()) {
    // Dot folders (`.inklode`, `.trash`) are not shown, as in the real core.
    if (path.startsWith(".")) continue;
    let level = root;
    const parts = path.split("/");
    parts.forEach((name, i) => {
      if (!name) return;
      const sub = parts.slice(0, i + 1).join("/");
      let entry = level.find((e) => e.name === name);
      if (!entry) {
        entry = i < parts.length - 1 ? { name, path: sub, children: [] } : { name, path: sub };
        level.push(entry);
      }
      level = entry.children ?? [];
    });
  }
  const sort = (list: Entry[]) => {
    list.sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name));
    list.forEach((e) => e.children && sort(e.children));
  };
  sort(root);
  return root;
}

const LINK = /\[\[([^[\]]+)\]\]/g;

/** `Note#heading|alias` -> `Note`. */
const target = (link: string) => link.split(/[#|]/)[0].trim();

/** The note a link points to: a full path without `.md`, or just a file name. */
function resolve(link: string, from: string): string | null {
  const wanted = target(link).toLowerCase().replace(/\.md$/, "");
  if (!wanted) return from; // `[[#heading]]` points into the same note
  const hit = [...files.keys()].find((p) => {
    const stem = p.replace(/\.md$/, "").toLowerCase();
    return stem === wanted || stem.endsWith("/" + wanted);
  });
  return hit ?? null;
}

function backlinks(path: string): Hit[] {
  const hits: Hit[] = [];
  for (const [other, content] of files) {
    if (other === path || other.startsWith(".")) continue;
    content.split("\n").forEach((text, i) => {
      if ([...text.matchAll(LINK)].some((m) => resolve(m[1], other) === path)) {
        hits.push({ path: other, line: i + 1, text });
      }
    });
  }
  return hits;
}

function search(query: string): Hit[] {
  const q = query.trim().toLowerCase();
  const hits: Hit[] = [];
  if (!q) return hits;
  for (const [path, content] of files) {
    if (path.startsWith(".")) continue;
    if (path.toLowerCase().includes(q)) hits.push({ path, line: 0, text: "" });
    content.split("\n").forEach((text, i) => {
      if (text.toLowerCase().includes(q)) hits.push({ path, line: i + 1, text });
    });
  }
  return hits.slice(0, 200);
}

/** The words of a text: its runs of letters and digits, in lowercase. */
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// shortcut: the mock scores a note by how many times it has the query's words, with a fixed bonus for one in the
// file name; the real core ranks with BM25 and also weighs aliases, tags and headings (crates/core/src/rank.rs).
function searchRanked(query: string, limit: number) {
  const terms = [...new Set(words(query))];
  const found = [];
  for (const path of notePaths()) {
    const lines = files.get(path)!.split("\n");
    const name = words(path.split("/").pop()!.replace(/\.md$/, ""));
    const count = (term: string) => words(lines.join("\n")).filter((w) => w === term).length + (name.includes(term) ? 5 : 0);
    const counts = terms.map(count);
    if (!counts.some(Boolean)) continue;
    const matching = lines.map((text, i) => ({ line: i + 1, text: text.trim().slice(0, 200) })).filter((l) => words(l.text).some((w) => terms.includes(w)));
    found.push({ all: counts.every(Boolean), path, score: counts.reduce((a, b) => a + b, 0), lines: matching.slice(0, 3) });
  }
  found.sort((a, b) => Number(b.all) - Number(a.all) || b.score - a.score || (a.path < b.path ? -1 : 1));
  return found.slice(0, limit).map(({ path, score, lines }) => ({ path, score, lines }));
}

/** The notes, sorted, as the real index has them: no dot files. */
const notePaths = () => [...files.keys()].filter((p) => p.endsWith(".md") && !p.startsWith(".")).sort();

/** For each note, the other notes its links reach. */
function linked(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const from of notePaths()) {
    const to = [...files.get(from)!.matchAll(LINK)].map((m) => resolve(m[1], from));
    out.set(from, new Set(to.filter((p): p is string => p !== null && p !== from && p.endsWith(".md"))));
  }
  return out;
}

/** From `start`, each note that links lead to in either direction, with the note before it on a shortest way there. */
function reach(out: Map<string, Set<string>>, start: string): Map<string, { distance: number; before: string }> {
  if (!out.has(start)) throw new Error(`not found: ${start}`);
  const seen = new Map([[start, { distance: 0, before: start }]]);
  const queue = [start];
  for (const at of queue) {
    const beside = [...out.get(at)!, ...[...out.keys()].filter((p) => out.get(p)!.has(at))];
    for (const next of beside) {
      if (seen.has(next)) continue;
      seen.set(next, { distance: seen.get(at)!.distance + 1, before: at });
      queue.push(next);
    }
  }
  return seen;
}

function graphNote(path: string, depth: number) {
  if (![1, 2, 3].includes(depth)) throw new Error("bad params for graph.note: depth is 1, 2 or 3");
  const out = linked();
  const seen = reach(out, notePath(path));
  const targets = [...files.get(path)!.matchAll(LINK)].filter((m) => resolve(m[1], path) === null && !assets.has(target(m[1])));
  const graph = {
    path,
    links: [...out.get(path)!].sort(),
    backlinks: [...out.keys()].filter((p) => out.get(p)!.has(path)),
    unresolved: [...new Set(targets.map((m) => target(m[1])))],
  };
  if (depth === 1) return graph;
  const near = [...seen].map(([p, { distance }]) => ({ path: p, distance })).filter((n) => n.distance > 1 && n.distance <= depth);
  near.sort((a, b) => a.distance - b.distance || (a.path < b.path ? -1 : 1));
  return { ...graph, near: near.slice(0, 200), nearTotal: near.length };
}

function graphPath(from: string, to: string) {
  const out = linked();
  const seen = reach(out, notePath(from));
  if (!out.has(notePath(to))) throw new Error(`not found: ${to}`);
  if (!seen.has(to)) return { found: false, path: [], steps: [] };
  const path = [to];
  while (path[0] !== from) path.unshift(seen.get(path[0])!.before);
  const steps = path.slice(1).map((next, i) => ({ from: path[i], to: next, linkIn: out.get(path[i])!.has(next) ? path[i] : next }));
  return { found: true, path, steps };
}

function rename(from: string, to: string): { updated: string[] } {
  if (!files.has(from)) throw new Error(`${from}: not found`);
  if (files.has(to)) throw new Error(`${to}: already exists`);
  const newName = to.replace(/\.md$/, "").split("/").pop()!;
  const updated: string[] = [];
  for (const [other, content] of files) {
    if (other === from) continue;
    const rewritten = content.replace(LINK, (whole, link: string) =>
      resolve(link, other) === from ? `[[${newName}${link.slice(target(link).length)}]]` : whole,
    );
    if (rewritten !== content) {
      files.set(other, rewritten);
      updated.push(other);
    }
  }
  files.set(to, files.get(from)!);
  files.delete(from);
  changed(from, to, ...updated);
  return { updated };
}

/** Moves a folder with everything in it. `to` is `.trash/…` for a delete. */
// shortcut: the mock rewrites no links here, so a link written with the folder's path breaks; bare names keep working.
function moveFolder(from: string, to: string) {
  const inside = (p: string) => p === from || p.startsWith(from + "/");
  const moving = [...files.keys(), ...folders].filter(inside);
  if (moving.length === 0) throw new Error(`${from}: not found`);
  if (inside(to) || from.startsWith(".")) throw new Error(`cannot move ${from} to ${to}`);
  if (!to.startsWith(".trash/") && [...files.keys(), ...folders].some((p) => p === to || p.startsWith(to + "/"))) {
    throw new Error(`${to}: already exists`);
  }
  for (const p of moving) {
    const now = to + p.slice(from.length);
    if (folders.delete(p)) folders.add(now);
    else {
      files.set(now, files.get(p)!);
      files.delete(p);
    }
  }
  changed(from, to);
}

/** As the real core: the `note.*` operations refuse a path with a part that starts with a dot, with this message. */
function notePath(path: string): string {
  if (path.split("/").some((part) => part.startsWith("."))) throw new Error(`path is outside the vault or has a part that starts with a dot: ${path}`);
  return path;
}

/** As the real core: the `config.*` operations reach `.inklode/` only. */
function configPath(path: string): string {
  if (!path.startsWith(".inklode/")) throw new Error(`path is outside the vault or has a part that starts with a dot: ${path}`);
  notePath(path.slice(".inklode/".length));
  return path;
}

/** One name for every spelling a Mac's disk takes for the same file: case and Unicode normal form are ignored. */
const spelling = (path: string) => path.normalize("NFC").toLowerCase();

/** The last check of each claim, by its note's path and whole line, as the core keeps them outside the vault. */
const checked = new Map<string, { passed: boolean; output: string | null }>();

/** The claims of the mock vault as the core's `claims.list` gives them. */
function claims() {
  const notes = [...files.keys()].filter((p) => p.endsWith(".md") && !p.startsWith(".")).sort();
  return notes.flatMap((path) =>
    files.get(path)!.split("\n").flatMap((full, i) => {
      const m = /^(.*)<!--\s*check:\s*(.+?)\s*-->\s*$/.exec(full);
      if (!m) return [];
      const last = checked.get(`${path}\n${full}`);
      const kind = /^file\s/.test(m[2]) ? "file" : /^https?:\/\//.test(m[2]) ? "url" : "command";
      const status = !last ? "unchecked" : last.passed ? "passing" : "failing";
      const day = last ? new Date().toISOString().slice(0, 10) : null;
      return [{ path, line: i + 1, text: m[1].trim().slice(0, 200), evidence: m[2], kind, status, checked: day, output: last?.output ?? null }];
    }),
  );
}

export function mockCall(name: string, params: Record<string, unknown>): unknown {
  const path = params.path as string;
  switch (name) {
    case "folder.rename":
      moveFolder(params.from as string, params.to as string);
      return { updated: [] };
    case "folder.delete":
      moveFolder(path, `.trash/${path}`);
      return { trashed: `.trash/${path}` };
    case "folder.new":
      if ([...files.keys(), ...folders].some((p) => p === path || p.startsWith(path + "/"))) throw new Error(`${path}: already exists`);
      folders.add(path);
      changed(path);
      return null;
    case "vault.open":
      return { root: path, name: path.split("/").pop(), watchError: null };
    case "vault.tree":
      return tree();
    case "note.read":
    case "config.read": {
      const file = name === "note.read" ? notePath(path) : configPath(path);
      if (!files.has(file)) throw new Error(`not found: ${file}`);
      return { content: files.get(file) };
    }
    case "note.write":
    case "config.write": {
      const file = name === "note.write" ? notePath(path) : configPath(path);
      // `base` is the text the caller last read or wrote; a missing file counts as empty. Only `note.write` takes it.
      if (name === "note.write" && typeof params.base === "string" && (files.get(file) ?? "") !== params.base) {
        throw new Error(`changed on disk since it was read: ${file}`);
      }
      files.set(file, params.content as string);
      changed(file);
      return null;
    }
    case "note.create": {
      const taken = [...files.keys(), ...folders].some((p) => spelling(p) === spelling(path) || spelling(p).startsWith(spelling(path) + "/"));
      if (taken) throw new Error(`already exists: ${notePath(path)}`);
      files.set(notePath(path), (params.content as string | undefined) ?? "");
      changed(path);
      return null;
    }
    case "note.resolve":
      return { path: resolve(params.link as string, params.from as string) };
    case "note.backlinks":
      return backlinks(path);
    case "search":
      return search(params.query as string);
    case "search.ranked":
      return searchRanked(params.query as string, Math.min(Math.max((params.limit as number | undefined) ?? 10, 1), 50));
    case "graph.note":
      return graphNote(path, (params.depth as number | undefined) ?? 1);
    case "graph.path":
      return graphPath(params.from as string, params.to as string);
    case "note.rename":
      return rename(params.from as string, params.to as string);
    case "note.delete": {
      if (!files.has(path)) throw new Error(`${path}: not found`);
      // shortcut: the mock overwrites an earlier trashed file of the same name; the real core numbers it.
      files.set(`.trash/${path}`, files.get(path)!);
      files.delete(path);
      changed(path);
      return { trashed: `.trash/${path}` };
    }
    case "vault.graph": {
      const notes = [...files.keys()].filter((p) => p.endsWith(".md") && !p.startsWith(".")).sort();
      // Keyed by both ends, so a link written twice is one edge.
      const edges = new Map<string, { from: string; to: string }>();
      for (const from of notes) {
        for (const m of files.get(from)!.matchAll(LINK)) {
          const to = resolve(m[1], from);
          if (to && to !== from) edges.set(`${from}\n${to}`, { from, to });
        }
      }
      const list = [...edges.values()];
      return {
        nodes: notes.map((path) => ({ path, links: list.filter((e) => e.from === path || e.to === path).length })),
        edges: list,
      };
    }
    // shortcut: the mock reads links and checkboxes in code blocks too, takes an embed of a file for a broken
    // link, and has no repositories to find a note stale against; the real core does all three.
    case "vault.health": {
      const notes = [...files.keys()].filter((p) => p.endsWith(".md") && !p.startsWith(".")).sort();
      const linked = new Set<string>();
      const broken = [];
      for (const from of notes) {
        const lost = [];
        for (const [i, text] of files.get(from)!.split("\n").entries()) {
          for (const m of text.matchAll(LINK)) {
            const to = resolve(m[1], from);
            if (!to) lost.push({ line: i + 1, link: m[1], text: text.trim() });
            else if (to !== from) linked.add(from).add(to);
          }
        }
        if (lost.length) broken.push({ path: from, links: lost });
      }
      return { broken, orphans: notes.filter((path) => !linked.has(path)), stale: [], unchecked: [] };
    }
    case "vault.tasks": {
      const notes = [...files.keys()].filter((p) => p.endsWith(".md") && !p.startsWith(".")).sort();
      const open = (path: string) =>
        files.get(path)!.split("\n").flatMap((text, i) => {
          const m = /^\s*(?:[-*+]|\d+[.)])\s+\[ \](?:\s+(.*))?$/.exec(text);
          return m ? [{ line: i + 1, text: (m[1] ?? "").trim() }] : [];
        });
      return notes.map((path) => ({ path, tasks: open(path) })).filter((note) => note.tasks.length);
    }
    // shortcut: the mock takes a marker in code for a claim too, checks only `file` claims (against its own
    // files), and never finds one stale; the real core does all of it (crates/core/src/claims.rs).
    case "claims.list":
      return claims();
    case "claims.check": {
      const claim = claims().find((c) => c.path === path && c.line === params.line);
      if (!claim) throw new Error(`no claim on line ${params.line} of ${path}`);
      if (claim.kind === "command") throw new Error("commands are not allowed for this vault");
      const there = claim.kind === "file" && files.has(claim.evidence.replace(/^file\s+/, ""));
      const output = claim.kind === "url" ? "the demo vault fetches nothing" : there ? null : "no such file";
      checked.set(`${path}\n${files.get(path)!.split("\n")[claim.line - 1]}`, { passed: there, output });
      return claims().find((c) => c.path === path && c.line === params.line);
    }
    case "config.list": {
      const names = (folder: string) =>
        [...files.keys()]
          .filter((p) => p.startsWith(`.inklode/${folder}/`) && p.endsWith(".css"))
          .map((p) => p.slice(`.inklode/${folder}/`.length, -".css".length))
          .sort();
      return { themes: names("themes"), snippets: names("snippets") };
    }
    // The demo vault has no git history.
    case "git.log":
    case "git.blame":
      return [];
    case "git.show":
      return { content: null };
    // And so nothing to review against.
    case "review.list":
      return { repository: false, entries: [] };
    case "review.base":
      return { content: null };
    case "review.accept":
    case "review.saved":
      return null;
    default:
      throw new Error(`unknown call: ${name}`);
  }
}
