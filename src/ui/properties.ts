/**
 * The properties inspector.
 *
 * Reads the selection and writes back through the same command layer the canvas
 * uses, so every field is undoable and behaves identically to dragging.
 *
 * Multi-selection shows a shared value where every node agrees and a "Mixed"
 * placeholder where they do not; typing into a mixed field sets all of them.
 *
 * The panel is rebuilt when the *shape* of the selection changes, but during a
 * canvas drag only the field values are refreshed — rebuilding the DOM 60 times
 * a second would fight with focus and caret position.
 */

import type { NodeId, SceneNode } from "../core/types.ts";
import { hasRadius, hasStroke } from "../core/types.ts";
import type { Editor } from "../core/editor.ts";
import type { ActionContext } from "../interaction/actions.ts";
import * as A from "../interaction/actions.ts";
import { updateNodes } from "../core/commands.ts";
import { DEG, round, toDegrees } from "../core/math.ts";
import { ICONS, clear, el, icon } from "./dom.ts";

type Getter = (node: SceneNode) => number | string | undefined;

/** Shared value across the selection, or null when they disagree. */
function shared<T>(nodes: SceneNode[], get: (n: SceneNode) => T): T | null {
  if (nodes.length === 0) return null;
  const first = get(nodes[0]!);
  return nodes.every((n) => get(n) === first) ? first : null;
}

export class PropertiesPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  /** Signature of the last render, so we only rebuild when the shape changes. */
  private signature = "";
  private fields = new Map<string, HTMLInputElement>();

  constructor(
    private readonly editor: Editor,
    private readonly ctx: () => ActionContext,
  ) {
    this.body = el("div", { class: "panel-body" });
    this.root = el("aside", { class: "panel panel-right" }, [
      el("header", { class: "panel-head" }, [el("span", { class: "panel-title", text: "Design" })]),
      this.body,
    ]);
  }

  render(force = false): void {
    const nodes = this.editor.selectedNodes;
    const signature = `${nodes.map((n) => `${n.id}:${n.type}`).join(",")}|${this.editor.selection.length}`;

    if (!force && signature === this.signature) {
      this.refreshValues(nodes);
      return;
    }
    this.signature = signature;
    this.fields.clear();
    clear(this.body);

    if (nodes.length === 0) {
      this.body.append(this.emptyState());
      return;
    }
    this.body.append(this.alignSection(nodes.length));
    this.body.append(this.layoutSection(nodes));
    this.body.append(this.appearanceSection(nodes));

    const textNodes = nodes.filter((n) => n.type === "text");
    if (textNodes.length === nodes.length && textNodes.length > 0) {
      this.body.append(this.textSection(nodes));
    }
    this.body.append(this.arrangeSection());
  }

  /** Cheap path: update input values in place without touching the DOM tree. */
  private refreshValues(nodes: SceneNode[]): void {
    for (const [key, input] of this.fields) {
      if (document.activeElement === input) continue; // Never fight the caret.
      const getter = GETTERS[key];
      if (!getter) continue;
      const value = shared(nodes, getter);
      if (input.type === "color") {
        input.value = typeof value === "string" ? value : "#000000";
      } else {
        input.value = value === null || value === undefined ? "" : String(value);
        input.placeholder = value === null ? "Mixed" : "";
      }
    }
  }

  private emptyState(): HTMLElement {
    return el("div", { class: "empty-state" }, [
      el("div", { class: "empty-badge" }, [icon(ICONS.cursor)]),
      el("p", { class: "empty-title", text: "Nothing selected" }),
      el("p", { class: "empty-hint", text: "Pick a layer, or press R to draw a rectangle." }),
    ]);
  }

  // --- Sections -------------------------------------------------------------

  private alignSection(count: number): HTMLElement {
    const ctx = this.ctx;
    const button = (path: string, label: string, run: () => void, disabled = false) => {
      const b = el("button", { class: "icon-button", title: label, "aria-label": label, disabled });
      b.append(icon(path));
      b.addEventListener("click", run);
      return b;
    };

    return this.section("Align", [
      el("div", { class: "align-grid" }, [
        button(ICONS.alignLeft, "Align left", () => A.align(ctx(), "left")),
        button(ICONS.alignHCenter, "Align horizontal centres", () => A.align(ctx(), "hcenter")),
        button(ICONS.alignRight, "Align right", () => A.align(ctx(), "right")),
        button(ICONS.alignTop, "Align top", () => A.align(ctx(), "top")),
        button(ICONS.alignVCenter, "Align vertical centres", () => A.align(ctx(), "vcenter")),
        button(ICONS.alignBottom, "Align bottom", () => A.align(ctx(), "bottom")),
        button(ICONS.distributeH, "Distribute horizontally", () => A.distribute(ctx(), "h"), count < 3),
        button(ICONS.distributeV, "Distribute vertically", () => A.distribute(ctx(), "v"), count < 3),
      ]),
    ]);
  }

  private layoutSection(nodes: SceneNode[]): HTMLElement {
    return this.section("Layout", [
      el("div", { class: "field-grid" }, [
        this.numberField("x", "X", nodes),
        this.numberField("y", "Y", nodes),
        this.numberField("w", "W", nodes, { min: 1 }),
        this.numberField("h", "H", nodes, { min: 1 }),
        this.numberField("rotation", "∠", nodes, { step: 1, suffix: "°" }),
        this.numberField("radius", "⌜", nodes, { min: 0, disabled: !nodes.every(hasRadius) }),
      ]),
    ]);
  }

  private appearanceSection(nodes: SceneNode[]): HTMLElement {
    const rows: HTMLElement[] = [
      el("div", { class: "field-row" }, [
        el("span", { class: "field-label", text: "Opacity" }),
        this.sliderField("opacity", nodes),
      ]),
    ];

    if (nodes.every(hasStroke)) {
      rows.push(
        el("div", { class: "field-row" }, [
          el("span", { class: "field-label", text: "Fill" }),
          this.colorField("fill", nodes),
        ]),
        el("div", { class: "field-row" }, [
          el("span", { class: "field-label", text: "Stroke" }),
          this.colorField("stroke", nodes),
        ]),
        el("div", { class: "field-row" }, [
          el("span", { class: "field-label", text: "Weight" }),
          this.numberField("strokeWidth", "", nodes, { min: 0, step: 0.5, bare: true }),
        ]),
      );
    }
    return this.section("Appearance", rows);
  }

  private textSection(nodes: SceneNode[]): HTMLElement {
    const alignButton = (value: "left" | "center" | "right", path: string, label: string) => {
      const current = shared(nodes, (n) => (n.type === "text" ? n.align : undefined));
      const b = el("button", {
        class: `icon-button${current === value ? " is-active" : ""}`,
        title: label,
        "aria-label": label,
      });
      b.append(icon(path));
      b.addEventListener("click", () => this.apply(nodes, { align: value }, "Text align"));
      return b;
    };

    return this.section("Text", [
      el("div", { class: "field-grid" }, [
        this.numberField("fontSize", "Size", nodes, { min: 1 }),
        this.numberField("fontWeight", "Weight", nodes, { min: 100, max: 900, step: 100 }),
        this.numberField("lineHeight", "Line", nodes, { min: 0.5, step: 0.1 }),
      ]),
      el("div", { class: "field-row" }, [
        el("span", { class: "field-label", text: "Colour" }),
        this.colorField("color", nodes),
      ]),
      el("div", { class: "field-row" }, [
        el("span", { class: "field-label", text: "Align" }),
        el("div", { class: "segmented" }, [
          alignButton("left", ICONS.alignLeft, "Align text left"),
          alignButton("center", ICONS.alignHCenter, "Align text centre"),
          alignButton("right", ICONS.alignRight, "Align text right"),
        ]),
      ]),
    ]);
  }

  private arrangeSection(): HTMLElement {
    const ctx = this.ctx;
    const pill = (path: string, label: string, run: () => void) => {
      const b = el("button", { class: "pill-button", title: label });
      b.append(icon(path), el("span", { text: label }));
      b.addEventListener("click", run);
      return b;
    };
    return this.section("Arrange", [
      el("div", { class: "pill-row" }, [
        pill(ICONS.front, "Front", () => A.reorder(ctx(), "front")),
        pill(ICONS.back, "Back", () => A.reorder(ctx(), "back")),
      ]),
      el("div", { class: "pill-row" }, [
        pill(ICONS.group, "Group", () => A.group(ctx())),
        pill(ICONS.trash, "Delete", () => A.deleteSelection(ctx())),
      ]),
    ]);
  }

  private section(title: string, children: HTMLElement[]): HTMLElement {
    return el("section", { class: "prop-section" }, [
      el("h3", { class: "section-title", text: title }),
      ...children,
    ]);
  }

  // --- Fields ---------------------------------------------------------------

  private numberField(
    key: string,
    label: string,
    nodes: SceneNode[],
    options: { min?: number; max?: number; step?: number; suffix?: string; disabled?: boolean; bare?: boolean } = {},
  ): HTMLElement {
    const getter = GETTERS[key];
    const value = getter ? shared(nodes, getter) : null;

    const input = el("input", {
      class: "num-input",
      type: "number",
      step: options.step ?? 1,
      min: options.min,
      max: options.max,
      value: value === null || value === undefined ? "" : String(value),
      placeholder: value === null ? "Mixed" : "",
      disabled: options.disabled,
      "aria-label": label || key,
    });
    this.fields.set(key, input);

    const commit = () => {
      if (input.value === "") return;
      const raw = Number(input.value);
      if (!Number.isFinite(raw)) return;
      this.apply(nodes, SETTERS[key]!(raw), `Set ${label || key}`);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        commit();
        input.blur();
      }
    });

    if (options.bare) return input;
    return el("label", { class: "field" }, [
      el("span", { class: "field-affix", text: `${label}${options.suffix ?? ""}` }),
      input,
    ]);
  }

  private sliderField(key: string, nodes: SceneNode[]): HTMLElement {
    const getter = GETTERS[key]!;
    const value = shared(nodes, getter);
    const input = el("input", {
      class: "slider",
      type: "range",
      min: 0,
      max: 100,
      step: 1,
      value: value === null ? 100 : Number(value),
      "aria-label": "Opacity",
    });
    this.fields.set(key, input);

    const readout = el("span", { class: "slider-readout", text: `${value === null ? "—" : value}%` });
    input.addEventListener("input", () => {
      readout.textContent = `${input.value}%`;
      // Slider drags merge into one undo entry via the shared merge key.
      this.apply(nodes, { opacity: Number(input.value) / 100 }, "Opacity", "opacity");
    });
    return el("div", { class: "slider-wrap" }, [input, readout]);
  }

  private colorField(key: "fill" | "stroke" | "color", nodes: SceneNode[]): HTMLElement {
    const getter = GETTERS[key]!;
    const value = shared(nodes, getter);
    const hasValue = typeof value === "string";

    const swatch = el("input", {
      class: "color-input",
      type: "color",
      value: hasValue ? value : "#ffffff",
      "aria-label": `${key} colour`,
    });
    this.fields.set(key, swatch);

    const hex = el("input", {
      class: "hex-input",
      type: "text",
      value: hasValue ? value : "",
      placeholder: value === null ? "Mixed" : "None",
      spellcheck: "false",
      "aria-label": `${key} hex`,
    });

    const write = (color: string) => {
      const patch =
        key === "color" ? { color } : key === "fill" ? { fill: { color } } : { stroke: { color } };
      // Painting a stroke onto something with no width would look like nothing
      // happened, so give it a default weight at the same time.
      if (key === "stroke") {
        this.apply(nodes, { ...patch, strokeWidth: Math.max(1, (nodes[0] as { strokeWidth?: number }).strokeWidth ?? 0) }, "Stroke");
      } else {
        this.apply(nodes, patch, "Fill");
      }
    };

    swatch.addEventListener("input", () => {
      hex.value = swatch.value;
      write(swatch.value);
    });
    hex.addEventListener("change", () => {
      const v = hex.value.trim();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) {
        swatch.value = v;
        write(v);
      }
    });
    hex.addEventListener("keydown", (e) => e.stopPropagation());

    const clearButton = el("button", { class: "icon-button subtle", title: "Remove", "aria-label": `Remove ${key}` });
    clearButton.append(icon(ICONS.close));
    clearButton.addEventListener("click", () => {
      const patch = key === "fill" ? { fill: undefined } : key === "stroke" ? { stroke: undefined } : {};
      if (key !== "color") this.apply(nodes, patch, "Remove paint");
    });

    return el("div", { class: "color-field" }, [swatch, hex, key === "color" ? null : clearButton].filter(Boolean) as HTMLElement[]);
  }

  private apply(
    nodes: SceneNode[],
    patch: Partial<SceneNode> | Record<string, unknown>,
    label: string,
    mergeKey: string | null = null,
  ): void {
    const ids: NodeId[] = nodes.map((n) => n.id);
    const patches = Object.fromEntries(ids.map((id) => [id, patch as Partial<SceneNode>]));
    this.editor.commit(label, (doc) => updateNodes(doc, patches), mergeKey);
  }
}

/** Reads the displayed value for a field key. */
const GETTERS: Record<string, Getter> = {
  x: (n) => round(n.x),
  y: (n) => round(n.y),
  w: (n) => round(n.w),
  h: (n) => round(n.h),
  rotation: (n) => round(toDegrees(n.rotation), 1),
  radius: (n) => (hasRadius(n) ? n.radius : undefined),
  opacity: (n) => Math.round(n.opacity * 100),
  strokeWidth: (n) => (hasStroke(n) ? n.strokeWidth : undefined),
  fill: (n) => (hasStroke(n) ? n.fill?.color : undefined),
  stroke: (n) => (hasStroke(n) ? n.stroke?.color : undefined),
  color: (n) => (n.type === "text" ? n.color : undefined),
  fontSize: (n) => (n.type === "text" ? n.fontSize : undefined),
  fontWeight: (n) => (n.type === "text" ? n.fontWeight : undefined),
  lineHeight: (n) => (n.type === "text" ? round(n.lineHeight, 2) : undefined),
};

/** Turns a typed number back into a document patch. */
const SETTERS: Record<string, (value: number) => Record<string, unknown>> = {
  x: (v) => ({ x: v }),
  y: (v) => ({ y: v }),
  w: (v) => ({ w: Math.max(v, 1) }),
  h: (v) => ({ h: Math.max(v, 1) }),
  rotation: (v) => ({ rotation: v * DEG }),
  radius: (v) => ({ radius: Math.max(v, 0) }),
  strokeWidth: (v) => ({ strokeWidth: Math.max(v, 0) }),
  fontSize: (v) => ({ fontSize: Math.max(v, 1) }),
  fontWeight: (v) => ({ fontWeight: Math.max(v, 100) }),
  lineHeight: (v) => ({ lineHeight: Math.max(v, 0.5) }),
  opacity: (v) => ({ opacity: v / 100 }),
};
