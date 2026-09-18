/** The keyboard shortcut sheet, generated from the shortcut table itself. */

import { SHORTCUTS, formatCombo } from "../interaction/shortcuts.ts";
import { ICONS, el, icon } from "./dom.ts";

const EXTRA: { group: string; keys: string; label: string }[] = [
  { group: "Canvas", keys: "Space + drag", label: "Pan the canvas" },
  { group: "Canvas", keys: "Scroll", label: "Pan vertically" },
  { group: "Canvas", keys: "Shift + scroll", label: "Pan horizontally" },
  { group: "Canvas", keys: "Ctrl + scroll", label: "Zoom at the pointer" },
  { group: "Canvas", keys: "Double-click", label: "Enter a group, or edit text" },
  { group: "Canvas", keys: "Alt + drag", label: "Duplicate while moving" },
  { group: "Canvas", keys: "Shift + drag", label: "Constrain to one axis" },
  { group: "Canvas", keys: "Shift + resize", label: "Keep the aspect ratio" },
  { group: "Canvas", keys: "Alt + resize", label: "Resize about the centre" },
  { group: "Canvas", keys: "Drag outside a corner", label: "Rotate" },
  { group: "Canvas", keys: "Shift + rotate", label: "Snap to 15°" },
];

export class HelpSheet {
  readonly root: HTMLElement;

  constructor() {
    const close = el("button", { class: "icon-button subtle", "aria-label": "Close" });
    close.append(icon(ICONS.close));
    close.addEventListener("click", () => this.hide());

    const groups = new Map<string, { keys: string; label: string }[]>();
    for (const s of SHORTCUTS) {
      // Several combos map to the same action (Ctrl+Y / Ctrl+Shift+Z); show the
      // first one only, so the sheet does not read like a changelog.
      const list = groups.get(s.group) ?? [];
      if (!list.some((entry) => entry.label === s.label)) {
        list.push({ keys: formatCombo(s.combo), label: s.label });
      }
      groups.set(s.group, list);
    }
    for (const extra of EXTRA) {
      const list = groups.get(extra.group) ?? [];
      list.push({ keys: extra.keys, label: extra.label });
      groups.set(extra.group, list);
    }

    const columns = el(
      "div",
      { class: "help-columns" },
      [...groups].map(([name, entries]) =>
        el("section", { class: "help-group" }, [
          el("h3", { class: "help-group-title", text: name }),
          ...entries.map((entry) =>
            el("div", { class: "help-row" }, [
              el("span", { class: "help-label", text: entry.label }),
              el("kbd", { class: "kbd", text: entry.keys }),
            ]),
          ),
        ]),
      ),
    );

    this.root = el("div", { class: "modal-backdrop", hidden: true }, [
      el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Keyboard shortcuts" }, [
        el("header", { class: "modal-head" }, [
          el("h2", { class: "modal-title", text: "Keyboard shortcuts" }),
          close,
        ]),
        columns,
      ]),
    ]);

    this.root.addEventListener("click", (event) => {
      if (event.target === this.root) this.hide();
    });
  }

  show(): void {
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add("is-open"));
  }

  hide(): void {
    this.root.classList.remove("is-open");
    setTimeout(() => {
      this.root.hidden = true;
    }, 180);
  }

  toggle(): void {
    this.root.hidden ? this.show() : this.hide();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }
}
