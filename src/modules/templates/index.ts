// The templates module, like Obsidian's core Templates plugin: the notes in the vault's template folder
// (`templateFolder` in settings.json, `_templates` by default) can be put into a note at the cursor, or be the
// start of a new note, with `{{title}}`, `{{date}}` and `{{time}}` filled in (template.ts).

import { EditorView, ViewPlugin } from "@codemirror/view";
import { currentOptions } from "../../config";
import { inActivePane, notePath, type AppApi } from "../../modules";
import { expand, insertTemplate, templatesIn } from "./template";

/** The editors on screen: one per pane that shows a note as text. */
const views = new Set<EditorView>();

const track = ViewPlugin.fromClass(
  class {
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      views.add(view);
    }
    destroy() {
      views.delete(this.view);
    }
  },
);

/** The folder templates are in, as the vault's settings say. */
const folder = () => currentOptions().templateFolder ?? "_templates";

/** A note's name: its file name without `.md`. */
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

interface Entry {
  path: string;
  children?: Entry[];
}

const filesOf = (entries: Entry[]): string[] => entries.flatMap((e) => (e.children ? filesOf(e.children) : [e.path]));

export function activate(app: AppApi) {
  app.editor.registerExtension(track);

  /** The templates there are now. Throws, saying where to put them, when there are none. */
  const templates = async () => {
    const found = templatesIn(filesOf(await app.core.call<Entry[]>("vault.tree")), folder());
    if (found.length === 0) throw new Error(`There are no templates: put notes in the folder ${folder()} to use them as templates`);
    return found;
  };

  /**
   * The template a command is for: `{template}` if given (a path, or a name in the template folder), else the one
   * the user picks. Null when the box was closed. Its text with line endings as the editor has them, "\n".
   */
  const chosen = async (params: unknown, label: string): Promise<string | null> => {
    const all = await templates();
    const given = (params as { template?: unknown } | undefined)?.template;
    let path: string | null;
    if (typeof given === "string") {
      const match = all.find((t) => t.path === given || t.name.toLowerCase() === given.replace(/\.md$/i, "").toLowerCase());
      if (!match) throw new Error(`No template ${given} in ${folder()}`);
      path = match.path;
    } else {
      path = await app.ui.pick({ label, action: "use", items: all.map((t) => ({ id: t.path, title: t.name, hint: t.hint || undefined })) });
    }
    if (path === null) return null;
    const { content } = await app.core.call<{ content: string }>("note.read", { path });
    return content.replace(/\r\n?/g, "\n");
  };

  app.commands.register({
    id: "template.insert",
    title: "Insert template",
    // `{template?}`: a template's path or name, without the picker.
    run: async (params) => {
      const view = inActivePane(views, (v) => v.dom);
      if (!view) throw new Error("Open a note to insert a template into it");
      if (view.state.readOnly) throw new Error("This note is in reading view; switch to editing to insert a template");
      const template = await chosen(params, "Insert template");
      // The note may have closed while the box was open.
      if (template === null || !view.dom.isConnected) return;
      const { from, to } = view.state.selection.main;
      const filled = expand(template, { title: nameOf(view.state.facet(notePath)), now: new Date() });
      const { changes, cursor } = insertTemplate(view.state.doc.toString(), from, to, filled);
      view.dispatch({ changes, selection: { anchor: cursor }, scrollIntoView: true, userEvent: "input.template" });
      view.focus();
    },
  });

  app.commands.register({
    id: "template.newNote",
    title: "New note from template",
    // `{template?, path?}`: without them it asks for the template, then for the new note's name or Folder/Name.
    run: async (params) => {
      const template = await chosen(params, "New note from template");
      if (template === null) return;
      const given = (params as { path?: unknown } | undefined)?.path;
      const typed = typeof given === "string" ? given : await app.ui.pick({ label: "New note from template: name or Folder/Name", action: "create" });
      if (!typed?.trim()) return;
      const name = typed.trim().replace(/^\/+/, "");
      const path = /\.md$/i.test(name) ? name : name + ".md";
      // Never over a file that is there: the core makes the note only if nothing has the path.
      // `own`: the user made it here, as with "New note…", so it does not wait in the review inbox.
      await app.core.call("note.create", { path, content: expand(template, { title: nameOf(path), now: new Date() }), own: true });
      app.notes.open(path);
    },
  });
}
