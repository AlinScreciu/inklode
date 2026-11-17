// A note's name with its folder after it, as a button that opens the note: the heading of a note's rows in
// the health and tasks panels.

export function NoteName({ path, onOpen }: { path: string; onOpen(path: string): void }) {
  const note = path.replace(/\.md$/i, "");
  const slash = note.lastIndexOf("/");
  return (
    <button className="upkeep-note" data-path={path} title={path} onClick={() => onOpen(path)}>
      {note.slice(slash + 1)}
      {slash > 0 && <span className="upkeep-folder">{note.slice(0, slash)}</span>}
    </button>
  );
}
