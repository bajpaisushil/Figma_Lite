/**
 * In-place text editing.
 *
 * A real <textarea> is positioned over the node using the *same* matrix the
 * renderer uses, so the caret, selection and line wrapping line up with the
 * painted text at any zoom or rotation. The alternative — editing in a side
 * panel — loses the direct-manipulation feel entirely.
 *
 * The textarea is sized in the node's own units and the matrix supplies the
 * zoom, which keeps font metrics identical to the canvas path.
 */

import type { NodeId, TextNode } from "../core/types.ts";
import type { Editor } from "../core/editor.ts";
import { updateNode } from "../core/commands.ts";
import { worldTransform } from "../core/document.ts";
import { mul } from "../core/math.ts";
import { viewMatrix } from "../core/viewport.ts";
import { el } from "./dom.ts";

export class TextEditor {
  readonly root: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private editingId: NodeId | null = null;
  private original = "";

  constructor(
    private readonly editor: Editor,
    private readonly onFinish: () => void,
  ) {
    this.textarea = el("textarea", {
      class: "text-edit",
      spellcheck: "false",
      wrap: "soft",
    });
    this.root = el("div", { class: "text-edit-layer", hidden: true }, [this.textarea]);

    this.textarea.addEventListener("blur", () => this.commit());
    this.textarea.addEventListener("input", () => this.syncLive());
    this.textarea.addEventListener("keydown", (event) => {
      // Escape reverts; Cmd/Ctrl+Enter and Esc both leave the field. Plain Enter
      // must insert a newline, so it is deliberately not handled here.
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancel();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.commit();
      }
      event.stopPropagation();
    });
  }

  get isEditing(): boolean {
    return this.editingId !== null;
  }

  /** Returns false when the node is not text, so the caller can fall through. */
  begin(id: NodeId): boolean {
    const node = this.editor.doc.nodes[id];
    if (!node || node.type !== "text") return false;

    this.editingId = id;
    this.original = node.text;
    this.textarea.value = node.text;
    this.root.hidden = false;
    this.position(node);

    this.textarea.focus();
    this.textarea.select();
    return true;
  }

  /** Re-anchors the field after a pan, zoom or window resize. */
  reposition(): void {
    if (!this.editingId) return;
    const node = this.editor.doc.nodes[this.editingId];
    if (!node || node.type !== "text") return this.cancel();
    this.position(node);
  }

  private position(node: TextNode): void {
    const screen = mul(viewMatrix(this.editor.viewport), worldTransform(this.editor.doc, node.id));
    const style = this.textarea.style;

    style.width = `${node.w}px`;
    style.height = `${node.h}px`;
    style.fontSize = `${node.fontSize}px`;
    style.fontFamily = node.fontFamily;
    style.fontWeight = String(node.fontWeight);
    style.lineHeight = String(node.lineHeight);
    style.textAlign = node.align;
    style.color = node.color;
    style.transformOrigin = "0 0";
    style.transform = `matrix(${screen.a}, ${screen.b}, ${screen.c}, ${screen.d}, ${screen.e}, ${screen.f})`;
  }

  /** Writes through on every keystroke so the canvas mirrors what is typed. */
  private syncLive(): void {
    const id = this.editingId;
    if (!id) return;
    const value = this.textarea.value;
    // Live edits bypass history; the single undo entry is recorded on commit.
    this.editor.live((doc) => updateNode(doc, id, { text: value }));
  }

  commit(): void {
    const id = this.editingId;
    if (!id) return;
    const value = this.textarea.value;
    this.editingId = null;
    this.root.hidden = true;

    const node = this.editor.doc.nodes[id];
    if (node && node.type === "text") {
      // Restore the original first so the commit records one clean before/after
      // pair rather than diffing against the live-typed state.
      this.editor.live((doc) => updateNode(doc, id, { text: this.original }));
      if (value !== this.original) {
        this.editor.commit("Edit text", (doc) => updateNode(doc, id, { text: value }));
      }
    }
    this.onFinish();
  }

  cancel(): void {
    const id = this.editingId;
    if (!id) return;
    this.editingId = null;
    this.root.hidden = true;
    this.editor.live((doc) => updateNode(doc, id, { text: this.original }));
    this.onFinish();
  }
}
