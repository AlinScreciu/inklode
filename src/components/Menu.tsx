import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { keyParts } from "../commands";

export type Icon = ComponentType<{ size?: number | string }>;

/** A key as keycaps: `Mod+P` shows as two caps, ⌘ and P. */
export function Keys({ k }: { k: string }) {
  return (
    <span className="keys">
      {keyParts(k).map((part, i) => (
        <kbd key={i}>{part}</kbd>
      ))}
    </span>
  );
}

export interface MenuItem {
  label: string;
  icon?: Icon;
  /** A key to show on the right, e.g. `Mod+E`. */
  shortcut?: string;
  /** Shown in the error colour: an action that removes something. */
  danger?: boolean;
  /** A tick in front, for a menu that chooses one of its items. */
  checked?: boolean;
  onPick(): void;
}

/** Where a menu opens. With `right`, `x` is where its right edge goes: for a menu under a button at the window's right. */
export interface MenuAt {
  x: number;
  y: number;
  right?: boolean;
}

/** The corner of `el` a menu hangs from: under its left edge, or under its right edge with `right`. */
export function below(el: Element, right = false): MenuAt {
  const box = el.getBoundingClientRect();
  return { x: right ? box.right : box.left, y: box.bottom + 4, right };
}

/**
 * Puts the focus back where it was when the component that calls this goes away,
 * unless something else has taken the focus by then (a dialog the component opened).
 */
export function useReturnFocus() {
  const [before] = useState(() => document.activeElement);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A moment later: in development React unmounts and mounts every component once more, and that is not going away.
      setTimeout(() => {
        const lost = !document.activeElement || document.activeElement === document.body;
        if (!mounted.current && lost && before instanceof HTMLElement && before.isConnected) before.focus();
      });
    };
  }, [before]);
}

interface Props {
  /** Accessible name, e.g. the file the menu is for. */
  label: string;
  /** "separator" draws a line between groups. */
  items: (MenuItem | "separator")[];
  at: MenuAt;
  onClose(): void;
}

/**
 * A popup menu: the context menu of the file tree, the "more" menu of a pane, the list of a `Select`.
 * Arrows, Home and End move, Enter picks, Escape or a click outside closes. Focus returns to where it was.
 */
export function Menu({ label, items, at, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: at.x, top: at.y });
  useReturnFocus();

  // Measured once it is in the page: moved so that it stays inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const fit = (wanted: number, size: number, room: number) => Math.max(margin, Math.min(wanted, room - size - margin));
    setPosition({
      left: fit(at.right ? at.x - width : at.x, width, window.innerWidth),
      top: fit(at.y, height, window.innerHeight),
    });
    // The ticked item if there is one, else the first.
    (el.querySelector<HTMLElement>('[aria-checked="true"]') ?? el.querySelector<HTMLElement>("[role^=menuitem]"))?.focus();
  }, [at.x, at.y, at.right]);

  const move = (step: number | "first" | "last") => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const now = all.indexOf(document.activeElement as HTMLElement);
    const next = step === "first" ? 0 : step === "last" ? all.length - 1 : (now + step + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <div
      className="menu-backdrop"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={box}
        className="menu"
        role="menu"
        aria-label={label}
        style={position}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") move(1);
          else if (e.key === "ArrowUp") move(-1);
          else if (e.key === "Home") move("first");
          else if (e.key === "End") move("last");
          else if (e.key === "Escape" || e.key === "Tab") onClose();
          else return;
          e.preventDefault();
          // So Escape does not also close a dialog the menu was opened from.
          e.stopPropagation();
        }}
      >
        {items.map((item, i) =>
          item === "separator" ? (
            <div key={i} className="menu-separator" role="separator" />
          ) : (
            <button
              key={i}
              className={"menu-item" + (item.danger ? " is-danger" : "")}
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              onMouseEnter={(e) => e.currentTarget.focus()}
              onClick={() => {
                onClose();
                item.onPick();
              }}
            >
              {item.checked !== undefined ? (
                <span className="menu-icon">{item.checked && <Check size={14} />}</span>
              ) : (
                item.icon && (
                  <span className="menu-icon">
                    <item.icon size={14} />
                  </span>
                )
              )}
              <span className="menu-label">{item.label}</span>
              {item.shortcut && <Keys k={item.shortcut} />}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

interface SelectProps {
  /** Accessible name: what is being chosen. */
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
}

/**
 * A drop-down drawn by the app, in place of a native `<select>`: its list is a `Menu`, so it looks like the
 * rest of the app and can be driven with synthetic events (the MCP tools), which a native popup cannot.
 */
export function Select({ label, value, options, onChange }: SelectProps) {
  const [at, setAt] = useState<MenuAt | null>(null);
  return (
    <>
      <button
        className="select"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={(e) => setAt(below(e.currentTarget))}
      >
        <span>{options.find((o) => o.value === value)?.label ?? value}</span>
        <ChevronsUpDown size={12} />
      </button>
      {at && (
        <Menu
          label={label}
          at={at}
          items={options.map((o) => ({ label: o.label, checked: o.value === value, onPick: () => onChange(o.value) }))}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

interface ConfirmProps {
  title: string;
  /** What will happen, in a sentence. */
  message: string;
  /** The text of the button that goes ahead, e.g. "Move to trash". */
  action: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** A small yes-or-no dialog. Enter goes ahead (the action button has the focus), Escape cancels. */
export function Confirm({ title, message, action, danger, onConfirm, onCancel }: ConfirmProps) {
  useReturnFocus();
  return (
    <div className="palette-backdrop" onMouseDown={onCancel}>
      <div
        className="confirm"
        role="alertdialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          // Tab stays inside: there are two buttons, so it goes to the other one.
          else if (e.key === "Tab") {
            const buttons = [...e.currentTarget.querySelectorAll("button")];
            buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + 1) % buttons.length].focus();
          } else return;
          e.preventDefault();
        }}
      >
        <h2 className="confirm-title">{title}</h2>
        <p className="confirm-message">{message}</p>
        <div className="confirm-buttons">
          <button className="button is-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button autoFocus className={"button" + (danger ? " is-danger" : "")} onClick={onConfirm}>
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
