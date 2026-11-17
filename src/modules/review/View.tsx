// The review inbox, in place of the note in a tab: the notes that wait at the left, and the changes of the
// picked one beside them (components/DiffPane.tsx), with Accept and Reject.

import { useEffect, useSyncExternalStore } from "react";
import { commands } from "../../commands";
import { DiffPane } from "../../components/DiffPane";
import { editors } from "../editors";
import { compared, inbox, select } from "./index";
import { type Entry, origin } from "./inbox";

const DETAIL = { changed: "Changed since you last looked", added: "New note", deleted: "Deleted note: the text it had" };

function Row({ entry, selected }: { entry: Entry; selected: boolean }) {
  const slash = entry.path.lastIndexOf("/");
  return (
    <li>
      <button
        className={"review-item" + (selected ? " is-selected" : "")}
        aria-current={selected ? "true" : undefined}
        data-path={entry.path}
        title={entry.path}
        onClick={() => void commands.run("review.select", { path: entry.path })}
      >
        <span className="review-item-top">
          <span className="review-name">{entry.path.slice(slash + 1).replace(/\.md$/i, "")}</span>
          <span className={`review-status is-${entry.status}`}>{entry.status}</span>
          <span className="diff-count is-add">+{entry.added}</span>
          <span className="diff-count is-remove">−{entry.removed}</span>
        </span>
        {slash > 0 && <span className="review-folder">{entry.path.slice(0, slash)}</span>}
        <span className="review-origin">{origin(entry)}</span>
      </button>
    </li>
  );
}

export default function View() {
  const { repository, entries, selected } = useSyncExternalStore(inbox.subscribe, inbox.get);
  // Draws again when a note's text changes in its editor, so the comparison is with the text as typed.
  useSyncExternalStore(editors.subscribe, editors.version);
  useEffect(() => {
    inbox.opened(true);
    return () => inbox.opened(false);
  }, []);
  // While the inbox shows, a note is always picked: the first, until the user picks.
  const first = selected === null ? entries[0]?.path : undefined;
  useEffect(() => {
    if (first !== undefined) void select(first).catch(commands.onError);
  }, [first]);

  // shortcut: what changed is asked of git, so a vault that is not in a git repository gets this message and
  // no inbox; keep the seen text of each note in the state folder if such vaults need review too
  if (!repository) {
    return (
      <div className="review">
        <p className="review-empty">Review needs a git repository: it shows what changed since a commit. This vault is not in one, or has no commit yet.</p>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="review">
        <p className="review-empty">Nothing waits for review. Notes that change outside Inklode, on disk or in a commit, are listed here.</p>
      </div>
    );
  }
  const entry = entries.find((e) => e.path === selected);
  const texts = compared();
  return (
    <div className="review">
      {/* The two are side by side, or the list is on top where the pane is narrow (app.css). */}
      <div className="review-columns">
        <aside className="review-list" aria-label="Notes to review">
          <header className="review-list-head">
            <span className="review-count">
              {entries.length} {entries.length === 1 ? "note" : "notes"} changed
            </span>
            <button className="button is-quiet" onClick={() => void commands.run("review.accept")}>
              Accept all
            </button>
          </header>
          <ul>
            {entries.map((e) => (
              <Row key={e.path} entry={e} selected={e.path === selected} />
            ))}
          </ul>
        </aside>
        {entry ? (
          // A new comparison per note: the folds opened in one mean nothing in the next.
          <DiffPane key={entry.path} title={entry.path} detail={`${DETAIL[entry.status]} · ${origin(entry)}`} before={texts?.before ?? null} after={texts?.after ?? ""}>
            <button className="button is-quiet" onClick={() => void commands.run("review.reject", { path: entry.path })}>
              Reject
            </button>
            <button className="button" onClick={() => void commands.run("review.accept", { path: entry.path })}>
              Accept
            </button>
          </DiffPane>
        ) : (
          <p className="review-empty">Pick a note to see what changed in it.</p>
        )}
      </div>
    </div>
  );
}
