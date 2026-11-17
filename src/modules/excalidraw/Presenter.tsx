import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { blocks, type Span } from "./notes";
import { keyMessage, PRESENTER_CHANNEL, type FromPresenter, type PresenterState, type ToPresenter } from "./slideshow";

const two = (n: number) => String(n).padStart(2, "0");

/** `12:05`, or `1:02:05` from an hour on. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(s / 3600);
  return (hours ? `${hours}:${two(Math.floor(s / 60) % 60)}` : String(Math.floor(s / 60))) + `:${two(s % 60)}`;
}

function inline(spans: Span[]): ReactNode[] {
  return spans.map((span, i) => {
    if (span.type === "text") return span.text;
    // A link is shown with where it points, and not followed: this window is not a browser.
    if (span.type === "link") return <span key={i} className="presenter-link" title={span.href}>{span.text}</span>;
    return createElement(span.type, { key: i }, span.text);
  });
}

/** The notes as React elements, so their text is never read as HTML. */
function Notes({ markdown }: { markdown: string }) {
  return blocks(markdown).map((block, i) => {
    if (block.type === "heading") return createElement(`h${Math.min(block.level, 3)}`, { key: i }, inline(block.spans));
    if (block.type === "code") return <pre key={i}>{block.text}</pre>;
    if (block.type === "paragraph") return <p key={i}>{inline(block.spans)}</p>;
    return createElement(block.ordered ? "ol" : "ul", { key: i }, block.items.map((item, at) => <li key={at}>{inline(item)}</li>));
  });
}

/**
 * The presenter view of a slideshow, alone in its own window (main.tsx, at `#presenter`): the slide on screen,
 * what Forward shows next, the slide's notes, progress, a clock and the time since the start.
 *
 * It is told what to show over a `BroadcastChannel` by the drawing that presents (View.tsx) and only sends back
 * "next", "previous", "go to" and "end". It never calls the app's core.
 */
export default function Presenter() {
  const [state, setState] = useState<PresenterState | null>(null);
  const [pictures, setPictures] = useState<{ key: string; current: string | null; next: string | null } | null>(null);
  const [now, setNow] = useState(Date.now);
  const channel = useRef<BroadcastChannel | null>(null);
  const notes = useRef<HTMLDivElement>(null);
  const send = (message: FromPresenter) => channel.current?.postMessage(message);

  useEffect(() => {
    const open = new BroadcastChannel(PRESENTER_CHANNEL);
    channel.current = open;
    open.onmessage = ({ data }: MessageEvent<ToPresenter>) => {
      if (data.type === "state") setState(data.state);
      else if (data.type === "pictures") setPictures(data);
      else setState(null);
    };
    open.postMessage({ type: "hello" } satisfies FromPresenter);
    const closed = () => open.postMessage({ type: "closed" } satisfies FromPresenter);
    window.addEventListener("pagehide", closed);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    // The keys of the drawing's window, without F: this window's size is the presenter's own business. It does not
    // move the slideshow itself, it asks (docs/slideshow-spec.md, "Keys").
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const message = keyMessage(e.key);
      if (!message) return;
      // Not also what the browser does with the key: scrolling the notes, pressing a focused button.
      e.preventDefault();
      // Once per press: not when the key is let go, and not for the repeats of a key held down.
      if (e.type === "keydown" && !e.repeat) open.postMessage(message satisfies FromPresenter);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("pagehide", closed);
      clearInterval(clock);
      open.close();
    };
  }, []);

  // The app's look, as the main window has it now: light or dark, the vault's theme and snippets, the look options.
  useEffect(() => {
    document.title = state ? `Presenter: ${state.title}` : "Inklode presenter";
    if (!state) return;
    const root = document.documentElement;
    root.dataset.appearance = state.dark ? "dark" : "light";
    root.style.cssText = state.options;
    let theme = document.head.querySelector("style[data-inklode-theme]");
    if (!theme) {
      theme = document.head.appendChild(document.createElement("style"));
      theme.setAttribute("data-inklode-theme", "");
    }
    if (theme.textContent !== state.css) theme.textContent = state.css;
  }, [state]);

  const drawn = state && pictures?.key === state.key ? pictures : null;
  // Tells the main window what is on screen here, so a test (and `ui_state`) can read this window.
  useEffect(() => {
    if (!state) return;
    const { index, count, title, build, next } = state;
    send({ type: "shown", shown: { index, count, title, build, next, notes: notes.current?.textContent ?? "", pictures: { current: Boolean(drawn?.current), next: Boolean(drawn?.next) } } });
  }, [state, drawn]);

  if (!state) return <div className="presenter presenter-idle">No slideshow is running.</div>;
  const { build, next } = state;
  return (
    <div className="presenter">
      <header className="presenter-head">
        <div className="presenter-where">
          <span className="presenter-count">
            {state.index + 1}
            <small> / {state.count}</small>
          </span>
          <span className="presenter-title">{state.title}</span>
          {build.total > 0 && (
            <span className="presenter-builds" title={`Build ${build.done} of ${build.total}`} aria-label={`Build ${build.done} of ${build.total}`}>
              {Array.from({ length: build.total }, (_, i) => (
                <i key={i} className={i < build.done ? "is-done" : undefined} />
              ))}
            </span>
          )}
        </div>
        <div className="presenter-time">
          <span title="Time since the slideshow started">{elapsed(now - state.startedAt)}</span>
          <small>{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
        </div>
      </header>
      <section className="presenter-slides">
        <figure className="presenter-now">
          <figcaption>Now</figcaption>
          {/* The last picture stays until the new one is drawn, so the view does not blink. */}
          <div className="presenter-picture">{pictures?.current && <img src={pictures.current} alt="" />}</div>
        </figure>
        <figure className="presenter-next">
          <figcaption>
            {next.kind === "build" ? `Next: build ${build.done + 1} of ${build.total}` : next.kind === "slide" ? `Next: ${next.title}` : "Next: end of the slideshow"}
          </figcaption>
          <div className="presenter-picture">{next.kind !== "end" && pictures?.next && <img src={pictures.next} alt="" />}</div>
        </figure>
      </section>
      <section className="presenter-notes" ref={notes} aria-label="Notes">
        {state.notes.trim() ? <Notes markdown={state.notes} /> : <p className="presenter-none">No notes for this slide.</p>}
      </section>
      <footer className="presenter-foot">
        <button className="button is-quiet" onClick={() => send({ type: "step", by: -1 })}>
          <ChevronLeft size={16} /> Previous
        </button>
        <button className="button" onClick={() => send({ type: "step", by: 1 })}>
          Next <ChevronRight size={16} />
        </button>
        <span className="presenter-spring" />
        <button className="button is-quiet" onClick={() => send({ type: "exit" })}>
          <X size={16} /> End
        </button>
      </footer>
    </div>
  );
}
