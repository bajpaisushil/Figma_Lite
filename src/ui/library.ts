/**
 * The storage panel: how much space the app is using, and every design it has
 * saved.
 *
 * Browser storage is invisible by default — an app can quietly hold hundreds of
 * megabytes of someone's disk with no way to see it or get it back. This panel
 * exists so that is never true here: it reports real usage from
 * `navigator.storage.estimate()`, shows what each saved design costs, and makes
 * deleting any of them a two-click operation.
 *
 * Destructive actions confirm in place rather than through a browser dialog —
 * a second click on the same button, which reverts if you ignore it.
 */

import type { DocumentLibrary, DocumentSummary, StorageUsage } from "../core/storage.ts";
import { formatBytes } from "../core/storage.ts";
import { ICONS, clear, el, icon } from "./dom.ts";

export interface LibraryCallbacks {
  open: (id: string) => void;
  create: () => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  clearAll: () => void;
}

/** "just now" / "12 min ago" / "yesterday" / "3 Sep". */
export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export class LibraryPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private meter: HTMLElement;
  private meterFill: HTMLElement;
  private meterLabel: HTMLElement;
  private readonly callbacks: LibraryCallbacks;
  /** Id of the row awaiting a confirming second click, and its reset timer. */
  private pendingDelete: string | null = null;
  private pendingTimer: number | undefined;

  constructor(callbacks: LibraryCallbacks) {
    this.callbacks = callbacks;

    const close = el("button", { class: "icon-button subtle", "aria-label": "Close" });
    close.append(icon(ICONS.close));
    close.addEventListener("click", () => this.hide());

    this.meterFill = el("div", { class: "meter-fill" });
    this.meterLabel = el("p", { class: "meter-label" });
    this.meter = el("div", { class: "meter" }, [
      el("div", { class: "meter-track" }, [this.meterFill]),
      this.meterLabel,
    ]);

    const create = el("button", { class: "pill-button" });
    create.append(icon(ICONS.plus), el("span", { text: "New design" }));
    create.addEventListener("click", () => {
      this.callbacks.create();
      this.hide();
    });

    this.body = el("div", { class: "library-list" });

    const clearAll = el("button", { class: "ghost-button danger", text: "Clear all saved data" });
    clearAll.addEventListener("click", () => {
      if (this.pendingDelete === "__all__") {
        this.resetPending();
        this.callbacks.clearAll();
        return;
      }
      this.arm("__all__", clearAll, "Delete everything?");
    });

    this.root = el("div", { class: "modal-backdrop", hidden: true }, [
      el("div", { class: "modal modal-narrow", role: "dialog", "aria-modal": "true", "aria-label": "Storage" }, [
        el("header", { class: "modal-head" }, [el("h2", { class: "modal-title", text: "Storage" }), close]),
        this.meter,
        el("div", { class: "library-head" }, [
          el("h3", { class: "section-title", text: "Your designs" }),
          create,
        ]),
        this.body,
        el("footer", { class: "library-foot" }, [clearAll]),
      ]),
    ]);

    this.root.addEventListener("click", (event) => {
      if (event.target === this.root) this.hide();
    });
  }

  render(documents: DocumentSummary[], activeId: string | null, usage: StorageUsage | null, now: number): void {
    this.renderMeter(usage, documents);
    clear(this.body);

    if (documents.length === 0) {
      this.body.append(
        el("p", { class: "empty-hint", text: "Nothing saved yet. Your work autosaves as you draw." }),
      );
      return;
    }

    for (const summary of documents) {
      this.body.append(this.renderRow(summary, summary.id === activeId, now));
    }
  }

  private renderMeter(usage: StorageUsage | null, documents: DocumentSummary[]): void {
    const designs = documents.reduce((sum, d) => sum + d.bytes, 0);

    if (!usage) {
      // No quota API (or a fallback backend): report what we can account for.
      this.meterFill.style.width = "0%";
      this.meterLabel.textContent = `${formatBytes(designs)} across ${documents.length} design${
        documents.length === 1 ? "" : "s"
      } · total space unknown`;
      return;
    }

    const percent = usage.quota > 0 ? Math.min(100, (usage.usage / usage.quota) * 100) : 0;
    // A sliver of fill so "almost nothing" still reads as a measurement.
    this.meterFill.style.width = `${Math.max(percent, usage.usage > 0 ? 1.5 : 0)}%`;
    this.meterFill.classList.toggle("is-full", percent > 85);
    this.meterLabel.textContent = `${formatBytes(usage.usage)} used of ${formatBytes(
      usage.quota,
    )} available on this device`;
  }

  private renderRow(summary: DocumentSummary, active: boolean, now: number): HTMLElement {
    const name = el("span", { class: "library-name", text: summary.name, title: summary.name });

    const meta = el("span", {
      class: "library-meta",
      text: `${summary.nodeCount - 1} layer${summary.nodeCount - 1 === 1 ? "" : "s"} · ${relativeTime(
        summary.updatedAt,
        now,
      )}`,
    });

    const remove = el("button", {
      class: "icon-button subtle danger",
      "aria-label": `Delete ${summary.name}`,
      title: "Delete",
    });
    remove.append(icon(ICONS.trash));
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.pendingDelete === summary.id) {
        this.resetPending();
        this.callbacks.remove(summary.id);
        return;
      }
      this.arm(summary.id, remove, "Sure?");
    });

    const row = el(
      "div",
      {
        class: `library-row${active ? " is-active" : ""}`,
        "data-id": summary.id,
        role: "button",
        tabindex: 0,
      },
      [
        el("div", { class: "library-dot" }),
        el("div", { class: "library-text" }, [name, meta]),
        el("span", { class: "library-size", text: formatBytes(summary.bytes) }),
        remove,
      ],
    );

    row.addEventListener("click", () => {
      if (active) return;
      this.callbacks.open(summary.id);
      this.hide();
    });
    row.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.beginRename(summary, name);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (active) return;
        this.callbacks.open(summary.id);
        this.hide();
      }
    });
    return row;
  }

  private beginRename(summary: DocumentSummary, target: HTMLElement): void {
    const input = el("input", { class: "library-rename", type: "text", value: summary.name });
    target.replaceWith(input);
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
      const value = input.value.trim();
      input.replaceWith(target);
      if (commit && value && value !== summary.name) this.callbacks.rename(summary.id, value);
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
      event.stopPropagation();
    });
  }

  /** Puts a destructive button into its confirming state, reverting if ignored. */
  private arm(id: string, button: HTMLElement, label: string): void {
    this.resetPending();
    this.pendingDelete = id;
    button.classList.add("is-confirming");
    const original = button.getAttribute("title") ?? "";
    button.setAttribute("title", label);
    if (button.tagName === "BUTTON" && button.textContent) button.textContent = label;

    this.pendingTimer = setTimeout(() => {
      button.classList.remove("is-confirming");
      button.setAttribute("title", original);
      if (button.tagName === "BUTTON" && button.textContent === label) {
        button.textContent = "Clear all saved data";
      }
      this.pendingDelete = null;
    }, 3500) as unknown as number;
  }

  private resetPending(): void {
    clearTimeout(this.pendingTimer);
    this.pendingDelete = null;
    for (const node of this.root.querySelectorAll(".is-confirming")) {
      node.classList.remove("is-confirming");
    }
  }

  show(): void {
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add("is-open"));
  }

  hide(): void {
    this.resetPending();
    this.root.classList.remove("is-open");
    setTimeout(() => {
      this.root.hidden = true;
    }, 180);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }
}

export type { DocumentLibrary };
