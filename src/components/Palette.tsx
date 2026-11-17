import { useState, type ReactNode } from "react";
import { Keys, useReturnFocus } from "./Menu";

export interface PaletteItem {
  id: string;
  title: string;
  /** Muted text on the right: a folder. It is searched too. */
  hint?: string;
  /** A shortcut such as `Mod+P`, shown on the right as keycaps. */
  shortcut?: string;
  /** A small icon before the title, for a kind of file that has one (a drawing). */
  icon?: ReactNode;
}

interface Props {
  /** Placeholder of the input and accessible name of the dialog. */
  label: string;
  /** The choices to filter. Leave out for a one-line text prompt. */
  items?: PaletteItem[];
  /** Text the input starts with. */
  initial?: string;
  /** What Enter does, for the hint under the box: "run", "open", "create". */
  action: string;
  /** Gets the id of the chosen item, or the typed text when there are no items. */
  onPick(value: string): void;
  onClose(): void;
}

// shortcut: only the first 100 matches are rendered, add a virtual list if vaults need more on screen
const MAX_SHOWN = 100;

/** True when the letters of `query` appear in `text` in order, ignoring case. */
function matches(query: string, text: string): boolean {
  const t = text.toLowerCase();
  let from = 0;
  for (const ch of query.toLowerCase()) {
    from = t.indexOf(ch, from) + 1;
    if (from === 0) return false;
  }
  return true;
}

/**
 * The centred input box behind the command palette, the quick switcher and
 * text prompts. With `items`: type to filter, arrows to move, Enter to pick.
 * Without: Enter submits the text. Escape closes.
 */
export function Palette({ label, items, initial = "", action, onPick, onClose }: Props) {
  const [query, setQuery] = useState(initial);
  const [index, setIndex] = useState(0);
  const found = items?.filter((item) => matches(query, `${item.title} ${item.hint ?? ""}`)).slice(0, MAX_SHOWN) ?? [];

  useReturnFocus();

  const pick = (value: string) => {
    onClose();
    onPick(value);
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={label} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder={label}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, found.length - 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter") {
              if (!items) query.trim() && pick(query);
              else if (found[index]) pick(found[index].id);
            } else return;
            e.preventDefault();
          }}
        />
        {items && (
          <ul className="palette-list">
            {found.map((item, i) => (
              <li key={item.id}>
                <button
                  ref={i === index ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  className={"palette-item" + (i === index ? " is-selected" : "")}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => pick(item.id)}
                >
                  {item.icon && <span className="palette-icon">{item.icon}</span>}
                  <span className="palette-title">{item.title}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {item.shortcut && <Keys k={item.shortcut} />}
                </button>
              </li>
            ))}
            {found.length === 0 && <li className="palette-empty">Nothing matches “{query}”</li>}
          </ul>
        )}
        <footer className="palette-footer">
          {items && (
            <span>
              <Keys k="ArrowUp" />
              <Keys k="ArrowDown" /> move
            </span>
          )}
          <span>
            <Keys k="Enter" /> {action}
          </span>
          <span>
            <Keys k="Escape" /> close
          </span>
        </footer>
      </div>
    </div>
  );
}
