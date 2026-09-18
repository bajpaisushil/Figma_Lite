/**
 * The export panel.
 *
 * Four formats with genuinely different trade-offs, so the panel states them
 * rather than leaving the choice to guesswork, and previews the output size
 * before committing.
 */

import type { ExportFormat, ExportRequest } from "../export/index.ts";
import type { Rect } from "../core/math.ts";
import { ICONS, clear, el, icon } from "./dom.ts";

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: "png", label: "PNG", hint: "Pixels, with transparency. Best for sharing a preview." },
  { id: "jpeg", label: "JPG", hint: "Pixels, smaller file, no transparency." },
  { id: "pdf", label: "PDF", hint: "Real vectors and selectable text. Best for print." },
  { id: "json", label: "JSON", hint: "The editable document. Import it back here." },
];

const SCALES = [1, 2, 3, 4];

export interface ExportPanelCallbacks {
  run: (request: Omit<ExportRequest, "documentName">) => void;
  /** Bounds of what would be exported, for the size preview. */
  preview: (selectionOnly: boolean) => Rect | null;
  hasSelection: () => boolean;
}

export class ExportPanel {
  readonly root: HTMLElement;
  private format: ExportFormat = "png";
  private scale = 2;
  private selectionOnly = false;
  private transparent = true;

  private formatRow!: HTMLElement;
  private optionsRow!: HTMLElement;
  private hint!: HTMLElement;
  private sizeLabel!: HTMLElement;
  private readonly callbacks: ExportPanelCallbacks;

  constructor(callbacks: ExportPanelCallbacks) {
    this.callbacks = callbacks;

    const close = el("button", { class: "icon-button subtle", "aria-label": "Close" });
    close.append(icon(ICONS.close));
    close.addEventListener("click", () => this.hide());

    this.formatRow = el("div", { class: "format-row" });
    this.optionsRow = el("div", { class: "export-options" });
    this.hint = el("p", { class: "export-hint" });
    this.sizeLabel = el("span", { class: "export-size" });

    const go = el("button", { class: "pill-button primary" });
    go.append(icon(ICONS.download), el("span", { text: "Export" }));
    go.addEventListener("click", () => {
      this.callbacks.run({
        format: this.format,
        selectionOnly: this.selectionOnly,
        scale: this.scale,
        background: this.backgroundColor(),
      });
      this.hide();
    });

    this.root = el("div", { class: "modal-backdrop", hidden: true }, [
      el("div", { class: "modal modal-narrow", role: "dialog", "aria-modal": "true", "aria-label": "Export" }, [
        el("header", { class: "modal-head" }, [el("h2", { class: "modal-title", text: "Export" }), close]),
        this.formatRow,
        this.hint,
        this.optionsRow,
        el("footer", { class: "export-foot" }, [this.sizeLabel, go]),
      ]),
    ]);

    this.root.addEventListener("click", (event) => {
      if (event.target === this.root) this.hide();
    });
  }

  private backgroundColor(): string | undefined {
    if (this.format === "json") return undefined;
    if (this.format === "jpeg") return "#ffffff";
    return this.transparent ? undefined : "#ffffff";
  }

  render(): void {
    clear(this.formatRow);
    for (const spec of FORMATS) {
      const button = el("button", {
        class: `format-button${this.format === spec.id ? " is-active" : ""}`,
        text: spec.label,
      });
      button.addEventListener("click", () => {
        this.format = spec.id;
        this.render();
      });
      this.formatRow.append(button);
    }

    this.hint.textContent = FORMATS.find((f) => f.id === this.format)?.hint ?? "";

    clear(this.optionsRow);
    const raster = this.format === "png" || this.format === "jpeg";

    if (this.format !== "json") {
      this.optionsRow.append(
        this.toggleRow("Selection only", this.selectionOnly, (value) => {
          this.selectionOnly = value;
          this.render();
        }, !this.callbacks.hasSelection()),
      );
    }

    if (raster) {
      const scales = el("div", { class: "segmented" });
      for (const scale of SCALES) {
        const button = el("button", {
          class: `scale-button${this.scale === scale ? " is-active" : ""}`,
          text: `${scale}×`,
        });
        button.addEventListener("click", () => {
          this.scale = scale;
          this.render();
        });
        scales.append(button);
      }
      this.optionsRow.append(
        el("div", { class: "field-row" }, [el("span", { class: "field-label", text: "Size" }), scales]),
      );
    }

    if (this.format === "png" || this.format === "pdf") {
      this.optionsRow.append(
        this.toggleRow("Transparent background", this.transparent, (value) => {
          this.transparent = value;
          this.render();
        }),
      );
    }

    const bounds = this.format === "json" ? null : this.callbacks.preview(this.selectionOnly);
    this.sizeLabel.textContent =
      this.format === "json"
        ? "Editable document"
        : !bounds
          ? "Nothing to export"
          : this.format === "pdf"
            ? `${Math.round(bounds.w)} × ${Math.round(bounds.h)} pt · vector`
            : `${Math.round(bounds.w * this.scale)} × ${Math.round(bounds.h * this.scale)} px`;
  }

  /** A jelly switch: the whole row is the hit target. */
  private toggleRow(
    label: string,
    value: boolean,
    onChange: (value: boolean) => void,
    disabled = false,
  ): HTMLElement {
    const knob = el("span", { class: "switch-knob" });
    const track = el("span", { class: `switch${value ? " is-on" : ""}` }, [knob]);
    const row = el("button", {
      class: `toggle-row${disabled ? " is-disabled" : ""}`,
      disabled,
      "aria-pressed": value ? "true" : "false",
    }, [el("span", { class: "field-label wide", text: label }), track]);

    row.addEventListener("click", () => {
      if (!disabled) onChange(!value);
    });
    return row;
  }

  show(): void {
    this.render();
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add("is-open"));
  }

  hide(): void {
    this.root.classList.remove("is-open");
    setTimeout(() => {
      this.root.hidden = true;
    }, 180);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }
}
