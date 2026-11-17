import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { commands } from "../commands";
import { call } from "../core/client";

/** One line in a note, as returned by `search` and `note.backlinks`. A file-name match has line 0 and no text. */
export interface Hit {
  path: string;
  line: number;
  text: string;
}

type OnOpen = (path: string, line?: number) => void;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A note name with the matching line under it, per hit. What `mark` matches in a line is highlighted. */
function HitList({ hits, mark, onOpen }: { hits: Hit[]; mark: RegExp; onOpen: OnOpen }) {
  return (
    <ul className="hits">
      {hits.map((hit, i) => {
        const note = hit.path.replace(/\.md$/, "");
        const slash = note.lastIndexOf("/");
        return (
          <li key={i}>
            <button className="hit" data-path={hit.path} data-line={hit.line} onClick={() => onOpen(hit.path, hit.line || undefined)}>
              <span className="hit-note">
                {note.slice(slash + 1)}
                {slash > 0 && <span className="hit-folder">{note.slice(0, slash)}</span>}
              </span>
              {hit.text && (
                <span className="hit-text">
                  {/* `mark` is one capture group, so the matches are the odd pieces. */}
                  {hit.text
                    .trim()
                    .split(mark)
                    .map((piece, n) => (n % 2 ? <mark key={n}>{piece}</mark> : piece))}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Whether the backlinks lists are unfolded: one choice for the footer of every pane and every note, until the
 * app is closed. They start folded, down to their header.
 */
// shortcut: not saved, so each launch starts folded; keep it in the vault's settings when that is wanted
let unfolded = false;
const footers = new Set<() => void>();
const show = (next: boolean) => {
  if (next === unfolded) return;
  unfolded = next;
  footers.forEach((changed) => changed());
};
const subscribe = (changed: () => void) => {
  footers.add(changed);
  return () => void footers.delete(changed);
};
// Registered once, here, not by each footer: the footers all follow `unfolded`.
commands.register([{ id: "backlinks.toggle", title: "Toggle backlinks", run: () => show(!unfolded) }]);

/**
 * The lines in other notes that link to `path`. Hidden until the status bar's backlink count is
 * clicked or the command `backlinks.toggle` runs. `refresh` changes when the vault does.
 */
export function Backlinks({ path, refresh, onOpen }: { path: string; refresh: number; onOpen: OnOpen }) {
  const [hits, setHits] = useState<Hit[]>([]);
  const open = useSyncExternalStore(subscribe, () => unfolded);

  useEffect(() => {
    let stale = false;
    call<Hit[]>("note.backlinks", { path }).then(
      (found) => stale || setHits(found),
      (e) => commands.onError(e),
    );
    return () => {
      stale = true;
    };
  }, [path, refresh]);

  // The links to this note in a line: `[[name]]`, with a folder before the name or `#heading` or `|alias` after it.
  // shortcut: a link written with one of the note's aliases is not highlighted; have the core return
  // where the link is in the line when that matters
  const name = escapeRegExp(path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, ""));
  const links = new RegExp(`(\\[\\[(?:[^\\]|#]*/)?${name}(?:\\.md)?(?:[#|][^\\]]*)?\\]\\])`, "gi");

  return (
    <div className="backlinks" hidden={!open || hits.length === 0}>
      <HitList hits={hits} mark={links} onOpen={onOpen} />
    </div>
  );
}

const SEARCH_DELAY_MS = 200;

/**
 * The sidebar search box. Shows results while there is a query and `children`
 * (the file tree) while the box is empty. Escape closes it.
 */
export function Search({
  refresh,
  onOpen,
  onClose,
  children,
}: {
  refresh: number;
  onOpen: OnOpen;
  onClose(): void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  // null while the first search for a query is still running.
  const [hits, setHits] = useState<Hit[] | null>(null);
  const active = query.trim() !== "";

  useEffect(() => {
    if (!active) return setHits(null);
    let stale = false;
    const timer = window.setTimeout(() => {
      call<Hit[]>("search", { query }).then(
        (found) => stale || setHits(found),
        (e) => commands.onError(e),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [query, active, refresh]);

  return (
    <>
      <input
        autoFocus
        className="search-input"
        type="search"
        placeholder="Search notes"
        aria-label="Search notes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      {!active ? (
        children
      ) : hits?.length === 0 ? (
        <p className="search-empty">No results</p>
      ) : (
        <HitList hits={hits ?? []} mark={new RegExp(`(${escapeRegExp(query.trim())})`, "gi")} onOpen={onOpen} />
      )}
    </>
  );
}
