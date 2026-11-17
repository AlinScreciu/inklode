// The claims panel, in the right sidebar: the review queue. Failing claims first, then stale ones (the oldest
// check first), then those never checked, then the passing ones folded to a count. A click on a claim's text
// opens its note at that line. Check runs the claim's evidence, "Check all" every claim that is not passing.

import { useEffect, useState, useSyncExternalStore } from "react";
import { commands } from "../../commands";
import { type Claim, keyOf, pending, queue, refused } from "./claims";
import { checkedLine, COMMANDS_OFF, LABEL, markSvg } from "./marks";
import { app, claims, live, runByUser, setOpen, state, stopAll } from "./state";

function Row({ claim }: { claim: Claim }) {
  const key = keyOf(claim);
  const error = state.errors.get(key);
  const note = claim.path.replace(/\.md$/i, "");
  return (
    <li className="claim" data-path={claim.path} data-line={claim.line} data-status={claim.status}>
      <span className={`claim-status is-${claim.status}`} role="img" aria-label={LABEL[claim.status]} dangerouslySetInnerHTML={{ __html: markSvg(claim.status) }} />
      <div className="claim-body">
        <button className="upkeep-row" title={`${claim.path}, line ${claim.line}`} onClick={() => app.openNote(claim.path, claim.line)}>
          {claim.text || "(no text)"}
        </button>
        <div className="claim-meta" title={claim.path}>
          {note} · {checkedLine(claim)}
        </div>
        <code className="claim-evidence">{claim.evidence}</code>
        {error && (
          <p className="claim-notice" role="status">
            {refused(error) ? (
              <>
                {COMMANDS_OFF}{" "}
                <button className="claim-link" onClick={() => void commands.run("settings.open", { section: "modules" })}>
                  Open Settings
                </button>
              </>
            ) : (
              error
            )}
          </p>
        )}
      </div>
      {/* One check runs at a time. */}
      <button
        className="button is-quiet claim-check"
        aria-label={`Check: ${claim.text}`}
        disabled={state.checking !== null || state.all}
        onClick={(event) => runByUser(event.nativeEvent, "claims.check", { path: claim.path, line: claim.line })}
      >
        {state.checking === key ? "Checking…" : "Check"}
      </button>
    </li>
  );
}

function Section({ title, rows }: { title: string; rows: Claim[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="upkeep-head">
        {title} <span className="upkeep-count">{rows.length}</span>
      </h3>
      <ul>
        {rows.map((claim) => (
          <Row key={keyOf(claim)} claim={claim} />
        ))}
      </ul>
    </section>
  );
}

export default function Panel() {
  const list = useSyncExternalStore(claims.subscribe, claims.get);
  // The rows read `state`; this draws them again when it changed.
  useSyncExternalStore(live.subscribe, live.version);
  const [passingOpen, setPassingOpen] = useState(false);
  useEffect(() => {
    setOpen(true);
    return () => setOpen(false);
  }, []);

  if (list.length === 0) {
    return (
      <p className="upkeep-empty">
        No claims. A line that ends with a comment like “&lt;!-- check: file Plans/Spec.md --&gt;” is listed here, and can be checked.
      </p>
    );
  }
  const { failing, stale, unchecked, passing } = queue(list);
  const left = pending(list).length;
  return (
    <div className="upkeep claims">
      <div className="claims-bar">
        {state.all ? (
          // Stopping is always allowed: it runs nothing.
          <button className="button is-quiet" disabled={state.stopping} onClick={stopAll}>
            {state.stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button className="button is-quiet" disabled={left === 0 || state.checking !== null} onClick={(event) => runByUser(event.nativeEvent, "claims.checkAll")}>
            Check all
          </button>
        )}
        <span className="claim-meta">{left === 0 ? "All claims pass" : `${left} to check`}</span>
      </div>
      <Section title="Failing" rows={failing} />
      <Section title="Stale" rows={stale} />
      <Section title="Unchecked" rows={unchecked} />
      {passing.length > 0 && (
        <section aria-label="Passing">
          <h3 className="upkeep-head">
            <button className="claims-fold" aria-expanded={passingOpen} onClick={() => setPassingOpen(!passingOpen)}>
              {passingOpen ? "▾" : "▸"} Passing <span className="upkeep-count">{passing.length}</span>
            </button>
          </h3>
          {passingOpen && (
            <ul>
              {passing.map((claim) => (
                <Row key={keyOf(claim)} claim={claim} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
