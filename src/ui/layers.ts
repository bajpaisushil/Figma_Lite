/**
 * The layers panel.
 *
 * Renders the document tree bottom-up (last child first) so the list reads in
 * the same order things stack on the canvas — the topmost layer is the top row.
 *
 * Rebuilds the whole list on document change. That is fine at this scale and
 * avoids a diffing layer; the rows are cheap and the panel is only repainted
 * when the document or selection actually changes, never during a drag frame.
 */

import type { NodeId, SceneNode } from "../core/types.ts";
import { isContainer } from "../core/types.ts";
import type { Editor } from "../core/editor.ts";
import type { InteractionEngine } from "../interaction/tools.ts";
import { moveNodeTo, updateNode } from "../core/commands.ts";
import { ancestorsOf, isAncestorOf } from "../core/document.ts";
import { ICONS, clear, el, icon } from "./dom.ts";

const TYPE_ICON: Record<SceneNode["type"], string> = {
  frame: ICONS.frame,
  group: ICONS.group,
  rect: ICONS.square,
  ellipse: ICONS.circle,
  text: ICONS.text,
  image: ICONS.image,
};

interface DropTarget {
  parentId: NodeId;
  index: number;
}

export class LayersPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private collapsed = new Set<NodeId>();
  private dragId: NodeId | null = null;
  private dropTarget: DropTarget | null = null;
  private dropLine: HTMLElement;

  constructor(
    private readonly editor: Editor,
    private readonly engine: InteractionEngine,
  ) {
    this.list = el("div", { class: "layer-list", role: "tree" });
    this.dropLine = el("div", { class: "drop-line", hidden: true });

    this.root = el("aside", { class: "panel panel-left" }, [
      el("header", { class: "panel-head" }, [
        el("span", { class: "panel-title", text: "Layers" }),
        el("span", { class: "panel-count", id: "layer-count" }),
      ]),
      el("div", { class: "layer-scroll" }, [this.list, this.dropLine]),
    ]);

    this.bindDragAndDrop();
  }

  render(): void {
    const { editor } = this;
    clear(this.list);

    const root = editor.doc.nodes[editor.doc.root];
    if (!root || !isContainer(root)) return;

    // Auto-expand ancestors of the selection so it is never hidden in a
    // collapsed branch after an undo or a canvas click.
    for (const id of editor.selection) {
      for (const ancestor of ancestorsOf(editor.doc, id)) this.collapsed.delete(ancestor.id);
    }

    const rows = document.createDocumentFragment();
    // Reverse: the last child paints on top, so it belongs at the top of the list.
    for (let i = root.children.length - 1; i >= 0; i--) {
      this.renderRow(root.children[i]!, 0, rows);
    }
    this.list.append(rows);

    const count = Object.keys(editor.doc.nodes).length - 1;
    const badge = this.root.querySelector("#layer-count");
    if (badge) badge.textContent = count === 1 ? "1 layer" : `${count} layers`;
  }

  private renderRow(id: NodeId, depth: number, into: DocumentFragment | HTMLElement): void {
    const { editor } = this;
    const node = editor.doc.nodes[id];
    if (!node) return;

    const container = isContainer(node);
    const isCollapsed = this.collapsed.has(id);
    const selected = editor.isSelected(id);
    const inScope = this.engine.scopeId === id;

    const twisty = el("button", {
      class: `twisty${container ? "" : " is-hidden"}${isCollapsed ? "" : " is-open"}`,
      "aria-label": isCollapsed ? "Expand" : "Collapse",
      tabindex: -1,
    });
    if (container) twisty.append(icon(ICONS.chevron));

    const row = el(
      "div",
      {
        class: [
          "layer-row",
          selected ? "is-selected" : "",
          inScope ? "is-scope" : "",
          node.visible ? "" : "is-hidden-node",
          node.locked ? "is-locked" : "",
          this.dragId === id ? "is-dragging" : "",
        ]
          .filter(Boolean)
          .join(" "),
        "data-id": id,
        draggable: "true",
        role: "treeitem",
        "aria-selected": selected ? "true" : "false",
        style: `--depth:${depth}`,
      },
      [
        twisty,
        icon(TYPE_ICON[node.type], "layer-type"),
        el("span", { class: "layer-name", text: node.name, title: node.name }),
        el("div", { class: "layer-actions" }, [
          this.toggleButton(id, "visible", node.visible),
          this.toggleButton(id, "locked", node.locked),
        ]),
      ],
    );

    into.append(row);

    if (container && !isCollapsed) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        this.renderRow(node.children[i]!, depth + 1, into);
      }
    }
  }

  private toggleButton(id: NodeId, field: "visible" | "locked", value: boolean): HTMLElement {
    const isVisible = field === "visible";
    const active = isVisible ? !value : value; // Show the button when it is "off".
    const button = el("button", {
      class: `layer-toggle${active ? " is-active" : ""}`,
      "data-toggle": field,
      "data-id": id,
      "aria-label": isVisible ? (value ? "Hide layer" : "Show layer") : value ? "Unlock layer" : "Lock layer",
      title: isVisible ? (value ? "Hide" : "Show") : value ? "Unlock" : "Lock",
      tabindex: -1,
    });
    button.append(icon(isVisible ? (value ? ICONS.eye : ICONS.eyeOff) : value ? ICONS.lock : ICONS.unlock));
    return button;
  }

  /** Single delegated listener for the whole list, rebuilt rows and all. */
  bindEvents(): void {
    this.list.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      const toggle = target.closest<HTMLElement>("[data-toggle]");
      if (toggle) {
        event.stopPropagation();
        const id = toggle.dataset.id!;
        const field = toggle.dataset.toggle as "visible" | "locked";
        const node = this.editor.doc.nodes[id];
        if (!node) return;
        this.editor.commit(field === "visible" ? "Toggle visibility" : "Toggle lock", (doc) =>
          updateNode(doc, id, { [field]: !node[field] }),
        );
        if (field === "locked" && !node.locked) {
          this.editor.setSelection(this.editor.selection.filter((s) => s !== id));
        }
        return;
      }

      const twisty = target.closest<HTMLElement>(".twisty");
      if (twisty && !twisty.classList.contains("is-hidden")) {
        event.stopPropagation();
        const id = twisty.closest<HTMLElement>(".layer-row")!.dataset.id!;
        this.collapsed.has(id) ? this.collapsed.delete(id) : this.collapsed.add(id);
        this.render();
        return;
      }

      const row = target.closest<HTMLElement>(".layer-row");
      if (!row) return;
      const id = row.dataset.id!;

      if (event.shiftKey) this.editor.toggleSelection(id);
      else this.editor.setSelection([id]);

      // Keep canvas scope in step, so clicking a nested layer selects it rather
      // than bouncing the selection up to its outermost group.
      const parent = this.editor.doc.nodes[id]?.parent ?? this.editor.doc.root;
      this.engine.setScope(parent);
    });

    this.list.addEventListener("dblclick", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".layer-row");
      if (!row) return;
      const nameEl = row.querySelector<HTMLElement>(".layer-name");
      if (nameEl) this.beginRename(row.dataset.id!, nameEl);
    });
  }

  private beginRename(id: NodeId, target: HTMLElement): void {
    const node = this.editor.doc.nodes[id];
    if (!node) return;

    const input = el("input", { class: "layer-rename", value: node.name, type: "text" });
    target.replaceWith(input);
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
      const value = input.value.trim();
      input.replaceWith(target);
      if (commit && value && value !== node.name) {
        this.editor.commit("Rename", (doc) => updateNode(doc, id, { name: value }));
      } else {
        this.render();
      }
    };

    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
      event.stopPropagation();
    });
  }

  /**
   * Drag to reorder and reparent. The drop indicator is computed from the
   * pointer's position within the hovered row: the middle third of a container
   * drops *into* it, the outer thirds drop before or after it.
   */
  private bindDragAndDrop(): void {
    this.list.addEventListener("dragstart", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".layer-row");
      if (!row) return;
      this.dragId = row.dataset.id!;
      event.dataTransfer?.setData("text/plain", this.dragId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      row.classList.add("is-dragging");
    });

    this.list.addEventListener("dragover", (event) => {
      if (!this.dragId) return;
      event.preventDefault();
      const row = (event.target as HTMLElement).closest<HTMLElement>(".layer-row");
      if (!row) return;

      const overId = row.dataset.id!;
      // Dropping a node into its own subtree would detach the tree from the root.
      if (overId === this.dragId || isAncestorOf(this.editor.doc, this.dragId, overId)) {
        this.hideDropLine();
        this.dropTarget = null;
        return;
      }

      const node = this.editor.doc.nodes[overId];
      if (!node) return;
      const rect = row.getBoundingClientRect();
      const ratio = (event.clientY - rect.top) / rect.height;
      const container = isContainer(node);

      if (container && ratio > 0.3 && ratio < 0.7) {
        this.dropTarget = { parentId: overId, index: node.children.length };
        this.showDropInto(row);
      } else {
        const parentId = node.parent ?? this.editor.doc.root;
        const parent = this.editor.doc.nodes[parentId];
        if (!parent || !isContainer(parent)) return;
        const positionInParent = parent.children.indexOf(overId);
        // The list is reversed, so "above the row" means a higher z-index.
        const index = ratio < 0.5 ? positionInParent + 1 : positionInParent;
        this.dropTarget = { parentId, index };
        this.showDropLine(row, ratio < 0.5);
      }
    });

    this.list.addEventListener("drop", (event) => {
      event.preventDefault();
      const dragId = this.dragId;
      const target = this.dropTarget;
      this.endDrag();
      if (!dragId || !target) return;
      this.editor.commit("Reorder layer", (doc) => moveNodeTo(doc, dragId, target.parentId, target.index));
    });

    this.list.addEventListener("dragend", () => this.endDrag());
    this.list.addEventListener("dragleave", (event) => {
      if (!this.list.contains(event.relatedTarget as Node)) this.hideDropLine();
    });
  }

  private showDropLine(row: HTMLElement, above: boolean): void {
    this.list.querySelectorAll(".is-drop-into").forEach((n) => n.classList.remove("is-drop-into"));
    const rect = row.getBoundingClientRect();
    const host = this.list.parentElement!.getBoundingClientRect();
    this.dropLine.hidden = false;
    this.dropLine.style.top = `${(above ? rect.top : rect.bottom) - host.top}px`;
    this.dropLine.style.left = `${rect.left - host.left}px`;
    this.dropLine.style.width = `${rect.width}px`;
  }

  private showDropInto(row: HTMLElement): void {
    this.dropLine.hidden = true;
    this.list.querySelectorAll(".is-drop-into").forEach((n) => n.classList.remove("is-drop-into"));
    row.classList.add("is-drop-into");
  }

  private hideDropLine(): void {
    this.dropLine.hidden = true;
    this.list.querySelectorAll(".is-drop-into").forEach((n) => n.classList.remove("is-drop-into"));
  }

  private endDrag(): void {
    this.dragId = null;
    this.dropTarget = null;
    this.hideDropLine();
    this.list.querySelectorAll(".is-dragging").forEach((n) => n.classList.remove("is-dragging"));
  }
}
