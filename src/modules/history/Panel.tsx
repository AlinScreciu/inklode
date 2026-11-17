// The history panel, in the right sidebar: the commits that changed the active note, and for the one that is
// picked what differs between it and the note's text now, with a button that puts the version back. The
// switch at the top says where that comparison shows: here under the list, or in a pane beside the note.

import { useEffect, useState, useSyncExternalStore } from "react";
import { commands } from "../../commands";
import { DiffView } from "../../components/DiffView";
import { currentOptions } from "../../config";
import type { PanelProps } from "../../modules";
import type { Commit } from "./blame";
import { changed, editors, viewFor } from "./editor";
import { call, DIFF_VIEW, panel, views } from "./index";

export default function Panel({ path, refresh }: PanelProps) {
  // A new list per note: what was picked in one note means nothing in the next.
  return <Versions key={path} path={path} refresh={refresh} />;
}

function Versions({ path, refresh }: PanelProps) {
  // Draws again when the note's text changes, so the comparison is with the text as typed.
  useSyncExternalStore(editors.subscribe, editors.version);
  const text = path === null ? null : (viewFor(path)?.state.doc.toString() ?? null);
  const [revisions, setRevisions] = useState<Commit[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The picked version's text: undefined while it is read, null if it cannot be read.
  const [before, setBefore] = useState<{ rev: string; text: string | null } | null>(null);
  // The vault's option `historyDiff`. The app draws the panel again when the settings change.
  const inPane = currentOptions().historyDiff === "pane";

  // Read again when files changed: a commit usually follows a save.
  useEffect(() => {
    if (path === null) return;
    let stale = false;
    call<Commit[]>("git.log", { path }).then(
      (list) => !stale && setRevisions(list),
      (e) => !stale && (setRevisions([]), commands.onError(e)),
    );
    return () => void (stale = true);
  }, [path, refresh]);

  useEffect(() => {
    if (path === null || selected === null) return;
    let stale = false;
    call<{ content: string | null }>("git.show", { path, rev: selected }).then(
      ({ content }) => !stale && setBefore({ rev: selected, text: content }),
      (e) => !stale && (setBefore({ rev: selected, text: null }), commands.onError(e)),
    );
    return () => void (stale = true);
  }, [path, selected]);
  const old = before?.rev === selected ? before.text : undefined;

  // For the commands, `ui_state` (index.ts) and the comparison in its own pane (Diff.tsx), which is told
  // when what it shows changed.
  useEffect(() => {
    const last = panel.shown;
    const picked = selected === null ? null : old;
    panel.shown = { path, revisions: revisions ?? [], selected, before: picked, select: setSelected };
    if (last?.path !== path || last.selected !== selected || last.before !== picked || last.revisions.length !== (revisions ?? []).length) changed();
  });
  useEffect(
    () => () => {
      panel.shown = null;
      changed();
    },
    [],
  );

  // The comparison's own pane is there while a version is picked and the option asks for it.
  useEffect(() => {
    if (inPane && selected !== null) views.show(DIFF_VIEW, true);
    else views.hide(DIFF_VIEW);
  }, [inPane, selected]);
  useEffect(() => () => views.hide(DIFF_VIEW), []);

  if (path === null || text === null) return <p className="history-empty">History shows the earlier versions of a note that is open as text.</p>;
  if (revisions === null) return null;
  if (revisions.length === 0) {
    return <p className="history-empty">No earlier versions. This note was never committed, or the vault is not in a git repository.</p>;
  }
  return (
    <div className="history">
      <div className="history-where">
        <span id="history-where-label">Show changes in</span>
        <div className="segmented" role="group" aria-labelledby="history-where-label">
          {(["sidebar", "pane"] as const).map((where) => (
            <button key={where} aria-pressed={inPane === (where === "pane")} onClick={() => void commands.run("settings.set", { key: "historyDiff", value: where })}>
              {where === "pane" ? "Pane" : "Sidebar"}
            </button>
          ))}
        </div>
      </div>
      <ul className="history-list" aria-label="Versions">
        {revisions.map((c) => (
          <li key={c.rev}>
            <button
              className={"history-item" + (c.rev === selected ? " is-selected" : "")}
              aria-current={c.rev === selected ? "true" : undefined}
              data-rev={c.rev}
              title={`${c.date} (${c.rev.slice(0, 7)})`}
              // A second click lets the version go.
              onClick={() => setSelected(c.rev === selected ? null : c.rev)}
            >
              <span className="history-meta">
                <span className="history-date">{c.date.slice(0, 16).replace("T", " ")}</span>
                <span className="history-author">{c.author}</span>
              </span>
              <span className="history-subject">{c.subject}</span>
            </button>
          </li>
        ))}
      </ul>
      {!inPane && selected !== null && old !== undefined && (
        <section className="history-compare" aria-label="Changes since this version">
          <header className="history-compare-head">
            <span className="history-compare-title">Changes since this version</span>
            <button className="button is-quiet" disabled={old === null || old === text} onClick={() => void commands.run("history.restore", { rev: selected })}>
              Restore this version
            </button>
          </header>
          {old === null ? <p className="history-empty">This version could not be read.</p> : <DiffView before={old} after={text} />}
        </section>
      )}
    </div>
  );
}
