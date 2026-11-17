// The tasks panel, in the right sidebar: the open checkboxes of every note, under the name of their note.

import { useEffect, useSyncExternalStore } from "react";
import { commands } from "../../commands";
import { NoteName } from "../NoteName";
import { openNote, panel, tasks } from "./index";

export default function Panel() {
  const notes = useSyncExternalStore(tasks.subscribe, tasks.get);
  useEffect(() => {
    panel.open = true;
    return () => void (panel.open = false);
  }, []);

  if (notes.length === 0) return <p className="upkeep-empty">No open tasks. A line like “- [ ] call back” in any note is listed here.</p>;
  return (
    <div className="upkeep">
      {notes.map((note) => (
        <section key={note.path} aria-label={note.path}>
          <NoteName path={note.path} onOpen={openNote} />
          <ul>
            {note.tasks.map((task) => (
              <li key={task.line} className="task">
                <input
                  type="checkbox"
                  className="md-task-checkbox"
                  checked={false}
                  aria-label={`Done: ${task.text}`}
                  data-path={note.path}
                  data-line={task.line}
                  onChange={() => void commands.run("tasks.tick", { path: note.path, line: task.line })}
                />
                <button className="upkeep-row" data-path={note.path} data-line={task.line} onClick={() => openNote(note.path, task.line)}>
                  {task.text || "(no text)"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
