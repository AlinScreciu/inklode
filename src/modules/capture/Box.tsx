import { useEffect, useRef } from "react";
import { applyOptions } from "../../appearance";
import { captureDone } from "../../core/client";

/**
 * The capture box, alone in its own small window (main.tsx, at `#capture`): one text field. Enter hands the
 * text to the main window, which appends it to the capture note (index.ts); Shift+Enter makes a new line;
 * Escape gives up. Either way the window goes away and the field is empty the next time.
 *
 * It never calls the app's core and does not know the vault: the window has no Tauri permission.
 */
export default function Box() {
  const field = useRef<HTMLTextAreaElement>(null);

  // Light or dark as the system is: the vault's theme is the main window's to know.
  useEffect(() => applyOptions(), []);

  // The window is hidden and shown again, not made anew: the keyboard goes to the field each time it comes up.
  useEffect(() => {
    const focus = () => field.current?.focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  const done = (text: string | null) => {
    if (field.current) field.current.value = "";
    void captureDone(text);
  };

  return (
    <textarea
      ref={field}
      className="capture-box"
      aria-label="Quick capture"
      placeholder="Capture a line. Enter saves it, Shift+Enter makes a new line, Esc cancels."
      autoFocus
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          done(null);
        } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          // Not while an input method is composing: there Enter picks a candidate.
          e.preventDefault();
          const text = e.currentTarget.value;
          done(text.trim() ? text : null);
        }
      }}
    />
  );
}
