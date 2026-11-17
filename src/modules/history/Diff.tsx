// What differs between the version picked in the history panel and the note's text now, in a pane of its own
// beside the note (components/DiffPane.tsx). The panel puts it up and takes it down (Panel.tsx) when the
// option `historyDiff` is "pane".

import { useSyncExternalStore } from "react";
import { commands } from "../../commands";
import { DiffPane } from "../../components/DiffPane";
import { editors, viewFor } from "./editor";
import { panel } from "./index";

export default function Diff() {
  // Draws again when the note's text changes and when another version is picked.
  useSyncExternalStore(editors.subscribe, editors.version);
  const { shown } = panel;
  const commit = shown?.revisions.find((c) => c.rev === shown.selected);
  const text = shown?.path ? viewFor(shown.path)?.state.doc.toString() : undefined;
  if (!shown?.path || !commit || text === undefined) return <p className="history-empty">Pick a version in the History panel to see what changed since.</p>;
  const { before } = shown;
  return (
    <DiffPane
      // A new comparison per version: the folds opened in one mean nothing in the next.
      key={`${shown.path}:${commit.rev}`}
      title={shown.path}
      detail={`Changes since ${commit.date.slice(0, 16).replace("T", " ")} · ${commit.author}: ${commit.subject}`}
      before={before ?? null}
      after={text}
      empty={before === null ? "This version could not be read." : ""}
    >
      <button className="button is-quiet" disabled={before == null || before === text} onClick={() => void commands.run("history.restore", { rev: commit.rev })}>
        Restore this version
      </button>
    </DiffPane>
  );
}
