/**
 * Keyboard shortcuts.
 *
 * Declared as a table rather than a switch, so the same data drives dispatch
 * and the help sheet — a shortcut cannot exist without being documented.
 *
 * `mod` means Cmd on macOS and Ctrl elsewhere.
 */

import type { ActionContext } from "./actions.ts";
import * as A from "./actions.ts";

const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

export interface Shortcut {
  /** Combo spec: modifiers in any order, then the key. e.g. "mod+shift+g". */
  combo: string;
  label: string;
  group: "Tools" | "Edit" | "Arrange" | "View" | "File";
  run: (ctx: ActionContext, event: KeyboardEvent) => void;
  /** Skipped when nothing is selected. */
  needsSelection?: boolean;
}

export const SHORTCUTS: Shortcut[] = [
  // Tools
  { combo: "v", label: "Select tool", group: "Tools", run: (c) => c.editor.setTool("select") },
  { combo: "h", label: "Hand tool", group: "Tools", run: (c) => c.editor.setTool("hand") },
  { combo: "f", label: "Frame", group: "Tools", run: (c) => c.editor.setTool("frame") },
  { combo: "r", label: "Rectangle", group: "Tools", run: (c) => c.editor.setTool("rect") },
  { combo: "o", label: "Ellipse", group: "Tools", run: (c) => c.editor.setTool("ellipse") },
  { combo: "t", label: "Text", group: "Tools", run: (c) => c.editor.setTool("text") },

  // Edit
  { combo: "mod+z", label: "Undo", group: "Edit", run: (c) => void c.editor.undo() },
  { combo: "mod+shift+z", label: "Redo", group: "Edit", run: (c) => void c.editor.redo() },
  { combo: "mod+y", label: "Redo", group: "Edit", run: (c) => void c.editor.redo() },
  { combo: "mod+c", label: "Copy", group: "Edit", run: (c) => void A.copy(c), needsSelection: true },
  { combo: "mod+x", label: "Cut", group: "Edit", run: (c) => void A.cut(c), needsSelection: true },
  { combo: "mod+v", label: "Paste", group: "Edit", run: (c) => void A.pasteHere(c) },
  { combo: "mod+d", label: "Duplicate", group: "Edit", run: A.duplicate, needsSelection: true },
  { combo: "mod+a", label: "Select all", group: "Edit", run: A.selectAll },
  { combo: "delete", label: "Delete", group: "Edit", run: A.deleteSelection, needsSelection: true },
  { combo: "backspace", label: "Delete", group: "Edit", run: A.deleteSelection, needsSelection: true },
  { combo: "escape", label: "Deselect / exit group", group: "Edit", run: A.deselectOrExitScope },

  // Arrange
  { combo: "mod+g", label: "Group", group: "Arrange", run: A.group, needsSelection: true },
  { combo: "mod+shift+g", label: "Ungroup", group: "Arrange", run: A.ungroup, needsSelection: true },
  { combo: "mod+]", label: "Bring to front", group: "Arrange", run: (c) => A.reorder(c, "front"), needsSelection: true },
  { combo: "mod+[", label: "Send to back", group: "Arrange", run: (c) => A.reorder(c, "back"), needsSelection: true },
  { combo: "]", label: "Bring forward", group: "Arrange", run: (c) => A.reorder(c, "forward"), needsSelection: true },
  { combo: "[", label: "Send backward", group: "Arrange", run: (c) => A.reorder(c, "backward"), needsSelection: true },
  { combo: "mod+shift+h", label: "Show / hide", group: "Arrange", run: A.toggleVisibility, needsSelection: true },
  { combo: "mod+shift+l", label: "Lock / unlock", group: "Arrange", run: A.toggleLock, needsSelection: true },

  { combo: "alt+a", label: "Align left", group: "Arrange", run: (c) => A.align(c, "left"), needsSelection: true },
  { combo: "alt+d", label: "Align right", group: "Arrange", run: (c) => A.align(c, "right"), needsSelection: true },
  { combo: "alt+w", label: "Align top", group: "Arrange", run: (c) => A.align(c, "top"), needsSelection: true },
  { combo: "alt+s", label: "Align bottom", group: "Arrange", run: (c) => A.align(c, "bottom"), needsSelection: true },
  { combo: "alt+shift+h", label: "Align centres horizontally", group: "Arrange", run: (c) => A.align(c, "hcenter"), needsSelection: true },
  { combo: "alt+shift+v", label: "Align centres vertically", group: "Arrange", run: (c) => A.align(c, "vcenter"), needsSelection: true },

  // Nudging
  { combo: "arrowleft", label: "Nudge left", group: "Arrange", run: (c) => A.nudge(c, -A.NUDGE_SMALL, 0), needsSelection: true },
  { combo: "arrowright", label: "Nudge right", group: "Arrange", run: (c) => A.nudge(c, A.NUDGE_SMALL, 0), needsSelection: true },
  { combo: "arrowup", label: "Nudge up", group: "Arrange", run: (c) => A.nudge(c, 0, -A.NUDGE_SMALL), needsSelection: true },
  { combo: "arrowdown", label: "Nudge down", group: "Arrange", run: (c) => A.nudge(c, 0, A.NUDGE_SMALL), needsSelection: true },
  { combo: "shift+arrowleft", label: "Nudge left ×10", group: "Arrange", run: (c) => A.nudge(c, -A.NUDGE_LARGE, 0), needsSelection: true },
  { combo: "shift+arrowright", label: "Nudge right ×10", group: "Arrange", run: (c) => A.nudge(c, A.NUDGE_LARGE, 0), needsSelection: true },
  { combo: "shift+arrowup", label: "Nudge up ×10", group: "Arrange", run: (c) => A.nudge(c, 0, -A.NUDGE_LARGE), needsSelection: true },
  { combo: "shift+arrowdown", label: "Nudge down ×10", group: "Arrange", run: (c) => A.nudge(c, 0, A.NUDGE_LARGE), needsSelection: true },

  // View
  { combo: "mod+=", label: "Zoom in", group: "View", run: A.zoomIn },
  { combo: "mod+-", label: "Zoom out", group: "View", run: A.zoomOut },
  { combo: "mod+0", label: "Zoom to 100%", group: "View", run: A.zoomReset },
  { combo: "mod+1", label: "Zoom to fit", group: "View", run: A.zoomFit },
  { combo: "mod+2", label: "Zoom to selection", group: "View", run: A.zoomToSelection, needsSelection: true },
  { combo: "mod+'", label: "Toggle snapping", group: "View", run: A.toggleSnapping },

  // File
  { combo: "mod+s", label: "Export JSON", group: "File", run: (c) => c.exportJSON() },
  { combo: "mod+shift+o", label: "Import JSON", group: "File", run: (c) => c.importJSON() },
];

/** Human-readable form for the help sheet, e.g. "⌘⇧G" or "Ctrl+Shift+G". */
export function formatCombo(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts);

  const pretty: Record<string, string> = {
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    arrowdown: "↓",
    delete: "Del",
    backspace: "⌫",
    escape: "Esc",
    "=": "+",
  };
  const keyLabel = pretty[key] ?? key.toUpperCase();

  if (IS_MAC) {
    return `${mods.has("mod") ? "⌘" : ""}${mods.has("shift") ? "⇧" : ""}${mods.has("alt") ? "⌥" : ""}${keyLabel}`;
  }
  const order = [mods.has("mod") ? "Ctrl" : "", mods.has("shift") ? "Shift" : "", mods.has("alt") ? "Alt" : ""].filter(Boolean);
  return [...order, keyLabel].join("+");
}

function matches(shortcut: Shortcut, event: KeyboardEvent): boolean {
  const parts = shortcut.combo.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts);

  const wantMod = mods.has("mod");
  const gotMod = IS_MAC ? event.metaKey : event.ctrlKey;
  if (wantMod !== gotMod) return false;
  if (mods.has("shift") !== event.shiftKey) return false;
  if (mods.has("alt") !== event.altKey) return false;
  // The non-mod modifier must not be pressed accidentally either.
  if (!wantMod && (IS_MAC ? event.ctrlKey : event.metaKey)) return false;

  return event.key.toLowerCase() === key || event.code.toLowerCase() === `key${key}`;
}

/**
 * Dispatches a key event. Returns true when a shortcut ran, so the caller can
 * call preventDefault only in that case and leave browser defaults alone
 * otherwise.
 */
export function dispatchShortcut(event: KeyboardEvent, ctx: ActionContext): boolean {
  for (const shortcut of SHORTCUTS) {
    if (!matches(shortcut, event)) continue;
    if (shortcut.needsSelection && ctx.editor.selection.length === 0) continue;
    shortcut.run(ctx, event);
    return true;
  }
  return false;
}

/** True when focus is in a field where typing must not trigger shortcuts. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export { IS_MAC };
