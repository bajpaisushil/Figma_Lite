/** Transient status messages. Stacked, auto-dismissing, never blocking. */

import { el } from "./dom.ts";

export class Toasts {
  readonly root: HTMLElement = el("div", { class: "toast-stack", role: "status", "aria-live": "polite" });

  show(message: string, tone: "info" | "warn" = "info", ms = 2400): void {
    const toast = el("div", { class: `toast toast-${tone}`, text: message });
    this.root.append(toast);

    // Let the element land before animating, so the entrance transition runs.
    requestAnimationFrame(() => toast.classList.add("is-in"));
    setTimeout(() => {
      toast.classList.remove("is-in");
      toast.addEventListener("transitionend", () => toast.remove(), { once: true });
      // Belt and braces: remove it even if the transition never fires.
      setTimeout(() => toast.remove(), 400);
    }, ms);
  }
}
