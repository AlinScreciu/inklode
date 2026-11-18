import type { PanelProps } from "../../modules";
import { openNote } from "./index";
import { Pane } from "./Pane";

/** The local graph, in the right sidebar: the active note and the notes within a few links of it. */
export default function Local({ path, refresh }: PanelProps) {
  return <Pane which="local" path={path ?? ""} onOpen={openNote} refresh={refresh} />;
}
