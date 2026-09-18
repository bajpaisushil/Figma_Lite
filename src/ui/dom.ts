/** Minimal DOM helpers. Not a framework — just less noise at the call sites. */

type Attrs = Record<string, string | number | boolean | undefined | null>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Window | Document,
  type: K | string,
  handler: (event: never) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler as EventListener, options);
  return () => target.removeEventListener(type, handler as EventListener, options);
}

/** Inline SVG icon from a 24×24 path, sized by CSS. */
export function icon(path: string, extra = ""): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", `icon ${extra}`.trim());
  svg.innerHTML = path;
  return svg;
}

export const ICONS = {
  cursor: '<path d="M5 3l14 7.5-6.2 1.6L9.6 19z"/>',
  hand: '<path d="M9 11V5.5a1.5 1.5 0 013 0V11m0-1.5a1.5 1.5 0 013 0V12m0-1a1.5 1.5 0 013 0v5a5 5 0 01-5 5h-2.2a5 5 0 01-3.9-1.9L6 15.6a1.6 1.6 0 012.4-2.1L9 14.2V8a1.5 1.5 0 013 0"/>',
  frame: '<path d="M6 3v18M18 3v18M3 6h18M3 18h18"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="4"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 15l-4.5-4L7 20"/>',
  undo: '<path d="M4 9h10a5 5 0 010 10h-6M4 9l4-4M4 9l4 4"/>',
  redo: '<path d="M20 9H10a5 5 0 000 10h6m4-10l-4-4m4 4l-4 4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M4 4l16 16M10 5.9A7.6 7.6 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 01-3.2 4M6.4 8A17 17 0 002.5 12S6 18.5 12 18.5a8.6 8.6 0 003.2-.6"/><path d="M9.6 9.8a3 3 0 004.3 4.2"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10" rx="3"/><path d="M8 10V7.5a4 4 0 018 0V10"/>',
  unlock: '<rect x="4.5" y="10" width="15" height="10" rx="3"/><path d="M8 10V7.5a4 4 0 017.5-1.8"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  group: '<rect x="3.5" y="3.5" width="8" height="8" rx="2"/><rect x="12.5" y="12.5" width="8" height="8" rx="2"/><path d="M11.5 7.5h4a1 1 0 011 1v4" stroke-dasharray="2 2"/>',
  trash: '<path d="M4 7h16M9 7V5.5A1.5 1.5 0 0110.5 4h3A1.5 1.5 0 0115 5.5V7m2 0l-.7 12a2 2 0 01-2 1.9H9.7a2 2 0 01-2-1.9L7 7"/>',
  download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/>',
  upload: '<path d="M12 20V9m0 0L8 13m4-4l4 4M5 5h14"/>',
  plus: '<path d="M12 6v12M6 12h12"/>',
  minus: '<path d="M6 12h12"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 114 2.3c-.9.6-1.6 1.1-1.6 2.2"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  magnet: '<path d="M7 4v8a5 5 0 0010 0V4h-4v8a1 1 0 01-2 0V4z"/>',
  alignLeft: '<path d="M4 3v18"/><rect x="7" y="6" width="11" height="4" rx="1.5"/><rect x="7" y="14" width="7" height="4" rx="1.5"/>',
  alignHCenter: '<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4" rx="1.5"/><rect x="8" y="14" width="8" height="4" rx="1.5"/>',
  alignRight: '<path d="M20 3v18"/><rect x="6" y="6" width="11" height="4" rx="1.5"/><rect x="10" y="14" width="7" height="4" rx="1.5"/>',
  alignTop: '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="11" rx="1.5"/><rect x="14" y="7" width="4" height="7" rx="1.5"/>',
  alignVCenter: '<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="8" width="4" height="8" rx="1.5"/>',
  alignBottom: '<path d="M3 20h18"/><rect x="6" y="6" width="4" height="11" rx="1.5"/><rect x="14" y="10" width="4" height="7" rx="1.5"/>',
  distributeH: '<path d="M4 4v16M20 4v16"/><rect x="9" y="8" width="6" height="8" rx="2"/>',
  distributeV: '<path d="M4 4h16M4 20h16"/><rect x="8" y="9" width="8" height="6" rx="2"/>',
  front: '<rect x="3" y="3" width="12" height="12" rx="3"/><path d="M9 21h9a3 3 0 003-3V9"/>',
  back: '<rect x="9" y="9" width="12" height="12" rx="3"/><path d="M15 3H6a3 3 0 00-3 3v9"/>',
} as const;
