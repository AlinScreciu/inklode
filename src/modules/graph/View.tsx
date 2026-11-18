import { useImperativeHandle } from "react";
import type { ViewProps } from "../../modules";
import { open } from "./index";
import { Pane } from "./Pane";

/**
 * The graph view: every note of the vault as a dot, every link as a line. Shown with no file of its own
 * (`AppApi.views.show`), so `path` is the note that was open, which is marked.
 */
export default function View({ ref, path, onOpen, refresh }: ViewProps) {
  useImperativeHandle(ref, () => ({ uiState: () => ({ graph: open.full?.uiState() ?? null }) }), []);
  return <Pane which="full" path={path} onOpen={onOpen} refresh={refresh} />;
}
