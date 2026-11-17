// The health panel, in the right sidebar: broken links, notes without links and stale notes, each under a
// heading with its count. A section with nothing in it is left out.

import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { NoteName } from "../NoteName";
import { health, openNote, panel } from "./index";

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="upkeep-head">
        {title} <span className="upkeep-count">{count}</span>
      </h3>
      {children}
    </section>
  );
}

/** The last part of a `repos:` entry, which can be a path: the repository's folder. The whole path is the row's tooltip. */
const folderName = (repo: string) => repo.replace(/\/+$/, "").split("/").pop() || repo;

export default function Panel() {
  const { broken, orphans, stale, unchecked } = useSyncExternalStore(health.subscribe, health.get);
  useEffect(() => {
    panel.open = true;
    return () => void (panel.open = false);
  }, []);

  const links = broken.reduce((sum, note) => sum + note.links.length, 0);
  if (links + orphans.length + stale.length + unchecked.length === 0) {
    return <p className="upkeep-empty">Nothing to look after: no broken links, no notes without links, no stale notes.</p>;
  }
  return (
    <div className="upkeep">
      <Section title="Broken links" count={links}>
        {broken.map((note) => (
          <div key={note.path}>
            <NoteName path={note.path} onOpen={openNote} />
            <ul>
              {note.links.map((link, i) => (
                <li key={i}>
                  <button className="upkeep-row" data-path={note.path} data-line={link.line} title={link.text} onClick={() => openNote(note.path, link.line)}>
                    [[{link.link}]]
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>
      <Section title="Stale notes" count={stale.length + unchecked.length}>
        {stale.map((note, i) => (
          <div key={i}>
            <NoteName path={note.path} onOpen={openNote} />
            <p className="upkeep-detail" title={note.dir}>
              Updated {note.updated}. {note.commits} newer {note.commits === 1 ? "commit" : "commits"} in {folderName(note.repo)}:
              <span className="upkeep-commit">
                {note.newest.date} <code>{note.newest.rev}</code> {note.newest.subject}
              </span>
            </p>
          </div>
        ))}
        {unchecked.map((note, i) => (
          <div key={i}>
            <NoteName path={note.path} onOpen={openNote} />
            <p className="upkeep-detail">? {note.repo === null ? note.reason : `${note.repo}: ${note.reason}`}</p>
          </div>
        ))}
      </Section>
      <Section title="Notes without links" count={orphans.length}>
        {orphans.map((path) => (
          <NoteName key={path} path={path} onOpen={openNote} />
        ))}
      </Section>
    </div>
  );
}
