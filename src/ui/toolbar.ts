/**
 * The toolbar: tool selection, history, zoom, file actions.
 *
 * Purely a view over the editor — it never holds state of its own, it just
 * reflects `editor.tool`, `history.canUndo` and so on, and calls actions.
 */

import type { Editor, ToolId } from "../core/editor.ts";
import type { ActionContext } from "../interaction/actions.ts";
import * as A from "../interaction/actions.ts";
import { formatCombo } from "../interaction/shortcuts.ts";
import { ICONS, el, icon } from "./dom.ts";

interface ToolSpec {
  id: ToolId;
  label: string;
  path: string;
  combo: string;
}

const TOOLS: ToolSpec[] = [
  { id: "select", label: "Select", path: ICONS.cursor, combo: "v" },
  { id: "hand", label: "Hand", path: ICONS.hand, combo: "h" },
  { id: "frame", label: "Frame", path: ICONS.frame, combo: "f" },
  { id: "rect", label: "Rectangle", path: ICONS.square, combo: "r" },
  { id: "ellipse", label: "Ellipse", path: ICONS.circle, combo: "o" },
  { id: "text", label: "Text", path: ICONS.text, combo: "t" },
];

export class Toolbar {
  readonly root: HTMLElement;
  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  private documentChip!: HTMLButtonElement;
  private documentLabel!: HTMLElement;
  private undoButton!: HTMLButtonElement;
  private redoButton!: HTMLButtonElement;
  private zoomReadout!: HTMLButtonElement;
  private snapButton!: HTMLButtonElement;

  constructor(
    private readonly editor: Editor,
    private readonly ctx: () => ActionContext,
    private readonly onShowHelp: () => void,
    private readonly onPickImage: () => void,
    private readonly onShowLibrary: () => void,
  ) {
    this.root = el("header", { class: "toolbar" }, [
      this.brand(),
      this.toolGroup(),
      this.rightGroup(),
    ]);
  }

  private brand(): HTMLElement {
    // The document chip doubles as the entry point to the storage panel: the
    // name you are editing, and one click to everything else you have saved.
    this.documentLabel = el("span", { class: "doc-name", text: "Untitled" });
    this.documentChip = el("button", {
      class: "doc-chip",
      title: "Saved designs and storage",
      "aria-label": "Saved designs and storage",
    });
    this.documentChip.append(icon(ICONS.files), this.documentLabel, icon(ICONS.chevron, "doc-caret"));
    this.documentChip.addEventListener("click", this.onShowLibrary);

    return el("div", { class: "brand" }, [
      el("div", { class: "brand-mark" }, [el("span", { text: "◆" })]),
      this.documentChip,
    ]);
  }

  setDocumentName(name: string): void {
    this.documentLabel.textContent = name;
    this.documentChip.title = `${name} — saved designs and storage`;
  }

  private toolGroup(): HTMLElement {
    const group = el("div", { class: "tool-group", role: "toolbar", "aria-label": "Tools" });

    for (const tool of TOOLS) {
      const button = el("button", {
        class: "tool-button",
        title: `${tool.label} · ${formatCombo(tool.combo)}`,
        "aria-label": tool.label,
        "aria-pressed": "false",
      });
      button.append(icon(tool.path));
      button.addEventListener("click", () => this.editor.setTool(tool.id));
      this.toolButtons.set(tool.id, button);
      group.append(button);
    }

    const image = el("button", { class: "tool-button", title: "Place image", "aria-label": "Place image" });
    image.append(icon(ICONS.image));
    image.addEventListener("click", this.onPickImage);
    group.append(image);

    return group;
  }

  private rightGroup(): HTMLElement {
    const ctx = this.ctx;

    this.undoButton = this.iconButton(ICONS.undo, "Undo", () => this.editor.undo());
    this.redoButton = this.iconButton(ICONS.redo, "Redo", () => this.editor.redo());
    this.snapButton = this.iconButton(ICONS.magnet, "Toggle snapping", () => A.toggleSnapping(ctx()));

    const zoomOut = this.iconButton(ICONS.minus, "Zoom out", () => A.zoomOut(ctx()));
    const zoomIn = this.iconButton(ICONS.plus, "Zoom in", () => A.zoomIn(ctx()));
    this.zoomReadout = el("button", { class: "zoom-readout", title: "Reset to 100%", text: "100%" });
    this.zoomReadout.addEventListener("click", () => A.zoomReset(ctx()));

    const fit = el("button", { class: "ghost-button", text: "Fit" });
    fit.title = `Zoom to fit · ${formatCombo("mod+1")}`;
    fit.addEventListener("click", () => A.zoomFit(ctx()));

    const importButton = this.iconButton(ICONS.upload, "Import JSON", () => ctx().importJSON());
    const exportButton = this.iconButton(ICONS.download, "Export JSON", () => ctx().exportJSON());
    const help = this.iconButton(ICONS.help, "Keyboard shortcuts", this.onShowHelp);

    return el("div", { class: "toolbar-right" }, [
      el("div", { class: "button-cluster" }, [this.undoButton, this.redoButton]),
      el("div", { class: "button-cluster" }, [this.snapButton]),
      el("div", { class: "button-cluster zoom-cluster" }, [zoomOut, this.zoomReadout, zoomIn, fit]),
      el("div", { class: "button-cluster" }, [importButton, exportButton, help]),
    ]);
  }

  private iconButton(path: string, label: string, run: () => void): HTMLButtonElement {
    const button = el("button", { class: "icon-button", title: label, "aria-label": label });
    button.append(icon(path));
    button.addEventListener("click", run);
    return button;
  }

  render(): void {
    for (const [id, button] of this.toolButtons) {
      const active = this.editor.tool === id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }

    this.undoButton.disabled = !this.editor.history.canUndo;
    this.redoButton.disabled = !this.editor.history.canRedo;
    this.undoButton.title = this.editor.history.undoLabel
      ? `Undo ${this.editor.history.undoLabel} · ${formatCombo("mod+z")}`
      : "Undo";
    this.redoButton.title = this.editor.history.redoLabel
      ? `Redo ${this.editor.history.redoLabel} · ${formatCombo("mod+shift+z")}`
      : "Redo";

    this.zoomReadout.textContent = `${Math.round(this.editor.viewport.zoom * 100)}%`;
    this.snapButton.classList.toggle("is-active", this.ctx().engine.snapEnabled);
  }
}
