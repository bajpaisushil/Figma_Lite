/**
 * Application shell.
 *
 * Wires the five layers together and owns the only `requestAnimationFrame` loop
 * in the app:
 *
 *   editor.subscribe(flags) → mark dirty → rAF → render what actually changed
 *
 * Nothing renders synchronously in an event handler. A pointermove that touches
 * the document, the selection and the overlay still costs exactly one frame.
 */

import "./styles.css";

import { Editor } from "./core/editor.ts";
import { deepWorldBounds, emptyDocument } from "./core/document.ts";
import { fromJSON, toJSON, ImportError } from "./core/serialize.ts";
import { type DocumentLibrary, openLibrary, uniqueName } from "./core/storage.ts";
import { SceneRenderer } from "./render/renderer.ts";
import { OverlayRenderer } from "./render/overlay.ts";
import { InteractionEngine } from "./interaction/tools.ts";
import { type ActionContext } from "./interaction/actions.ts";
import { dispatchShortcut, isTextEntryTarget } from "./interaction/shortcuts.ts";
import { insertImageFile, paste } from "./interaction/clipboard.ts";
import { insertNode } from "./core/commands.ts";
import { LayersPanel } from "./ui/layers.ts";
import { PropertiesPanel } from "./ui/properties.ts";
import { Toolbar } from "./ui/toolbar.ts";
import { Toasts } from "./ui/toast.ts";
import { HelpSheet } from "./ui/help.ts";
import { LibraryPanel } from "./ui/library.ts";
import { TextEditor } from "./ui/textEditor.ts";
import { el } from "./ui/dom.ts";
import { sampleDocument } from "./sample.ts";

/** How long after the last edit the document is written to storage. */
const AUTOSAVE_DEBOUNCE_MS = 800;

async function boot(): Promise<void> {
  const editor = new Editor();
  // Assigned once the async library is open; everything that touches it is
  // either scheduled after that point or guards on null.
  let library: DocumentLibrary | null = null;
  let activeId: string | null = null;

  // --- DOM scaffold ---------------------------------------------------------
  const sceneCanvas = el("canvas", { class: "scene-canvas" });
  const overlayCanvas = el("canvas", { class: "overlay-canvas" });
  const status = el("div", { class: "statusbar" });
  const canvasHost = el("div", { class: "canvas-host" }, [sceneCanvas, overlayCanvas]);

  const toasts = new Toasts();
  const help = new HelpSheet();

  const fileInput = el("input", { type: "file", accept: "application/json,.json", class: "visually-hidden" });
  const imageInput = el("input", { type: "file", accept: "image/*", class: "visually-hidden" });

  // --- Layers ---------------------------------------------------------------
  let dirtyScene = true;
  let dirtyOverlay = true;
  let frameRequested = false;

  const renderer = new SceneRenderer(sceneCanvas, () => {
    // A late-decoding image must trigger a repaint or it never appears.
    dirtyScene = true;
    schedule();
  });
  const overlay = new OverlayRenderer(overlayCanvas);

  const textEditor = new TextEditor(editor, () => {
    dirtyScene = true;
    dirtyOverlay = true;
    schedule();
  });
  canvasHost.append(textEditor.root, status);

  const engine = new InteractionEngine(editor, {
    onOverlayChange: () => {
      dirtyOverlay = true;
      schedule();
    },
    beginTextEdit: (id) => textEditor.begin(id),
    setCursor: (cursor) => {
      overlayCanvas.style.cursor = cursor;
    },
  });

  const context = (): ActionContext => ({
    editor,
    engine,
    viewportCenterWorld: () =>
      editor.toWorld({ x: editor.viewport.width / 2, y: editor.viewport.height / 2 }),
    exportJSON: exportDocument,
    importJSON: () => fileInput.click(),
    toast: (message) => toasts.show(message),
  });

  const libraryPanel = new LibraryPanel({
    open: (id) => void openDocument(id),
    create: () => void createDocument(),
    rename: (id, name) => void renameDocument(id, name),
    remove: (id) => void removeDocument(id),
    clearAll: () => void clearLibrary(),
  });

  const layers = new LayersPanel(editor, engine);
  const properties = new PropertiesPanel(editor, context);
  const toolbar = new Toolbar(
    editor,
    context,
    () => help.toggle(),
    () => imageInput.click(),
    () => void showLibrary(),
  );
  layers.bindEvents();

  document.body.append(
    el("div", { class: "app" }, [
      toolbar.root,
      el("main", { class: "workspace" }, [layers.root, canvasHost, properties.root]),
      toasts.root,
      help.root,
      libraryPanel.root,
      fileInput,
      imageInput,
    ]),
  );

  // --- Render loop ----------------------------------------------------------

  function schedule(): void {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      draw();
    });
  }

  function draw(): void {
    if (dirtyScene) {
      renderer.render(editor.doc, editor.viewport);
      dirtyScene = false;
    }
    if (dirtyOverlay) {
      overlay.render(editor.doc, editor.selection, editor.viewport, {
        marquee: engine.marquee,
        guides: engine.guides,
        hoverId: engine.isDragging ? null : editor.hoverId,
        badge: engine.badge,
        hideHandles: engine.isDragging && engine.state !== "resize",
        scopeId: engine.scopeId,
      });
      dirtyOverlay = false;
    }
    syncGrid();
    renderStatus();
  }

  /** The backdrop grid is CSS, so it costs nothing to draw — just reposition it. */
  function syncGrid(): void {
    const { panX, panY, zoom } = editor.viewport;
    const size = 24 * zoom;
    canvasHost.style.setProperty("--grid-size", `${size}px`);
    canvasHost.style.setProperty("--grid-x", `${panX % size}px`);
    canvasHost.style.setProperty("--grid-y", `${panY % size}px`);
    canvasHost.style.setProperty("--grid-alpha", zoom < 0.4 ? "0" : "1");
  }

  function renderStatus(): void {
    const { painted, culled, frameMs } = renderer.stats;
    const count = editor.selection.length;
    status.textContent = [
      `${Math.round(editor.viewport.zoom * 100)}%`,
      count === 0 ? "no selection" : count === 1 ? "1 selected" : `${count} selected`,
      `${painted} painted · ${culled} culled · ${frameMs.toFixed(1)}ms`,
      library ? STORE_LABEL[library.kind] : "storage…",
    ].join("   ·   ");
  }

  editor.subscribe((flags) => {
    if (flags.document || flags.viewport) dirtyScene = true;
    if (flags.document || flags.selection || flags.viewport || flags.overlay || flags.tool) {
      dirtyOverlay = true;
    }
    if (flags.document || flags.selection) {
      layers.render();
      properties.render();
      engine.syncScope();
    }
    if (flags.tool || flags.history || flags.viewport) toolbar.render();
    if (flags.viewport) textEditor.reposition();
    if (flags.document) queueAutosave();
    schedule();
  });

  // --- Sizing ---------------------------------------------------------------

  const resize = (): void => {
    const rect = canvasHost.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    renderer.resize(width, height);
    overlay.resize(width, height);
    editor.setViewport({ width, height });
    dirtyScene = true;
    dirtyOverlay = true;
    schedule();
  };
  new ResizeObserver(resize).observe(canvasHost);

  // --- Pointer input --------------------------------------------------------

  const pointerPos = (event: PointerEvent | MouseEvent | WheelEvent | DragEvent): { x: number; y: number } => {
    const rect = overlayCanvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  overlayCanvas.addEventListener("pointerdown", (event) => {
    if (textEditor.isEditing) textEditor.commit();
    overlayCanvas.setPointerCapture(event.pointerId);
    engine.setModifiers({ shift: event.shiftKey, alt: event.altKey, meta: event.metaKey || event.ctrlKey });
    engine.pointerDown(pointerPos(event), event.button);
    event.preventDefault();
  });

  overlayCanvas.addEventListener("pointermove", (event) => {
    engine.setModifiers({ shift: event.shiftKey, alt: event.altKey, meta: event.metaKey || event.ctrlKey });
    engine.pointerMove(pointerPos(event));
  });

  const endPointer = (event: PointerEvent): void => {
    if (overlayCanvas.hasPointerCapture(event.pointerId)) {
      overlayCanvas.releasePointerCapture(event.pointerId);
    }
    engine.pointerUp();
  };
  overlayCanvas.addEventListener("pointerup", endPointer);
  overlayCanvas.addEventListener("pointercancel", endPointer);

  overlayCanvas.addEventListener("dblclick", (event) => {
    engine.doubleClick(pointerPos(event));
    event.preventDefault();
  });

  overlayCanvas.addEventListener("contextmenu", (event) => event.preventDefault());

  overlayCanvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const at = pointerPos(event);
      // Trackpad pinch arrives as a wheel event with ctrlKey set — the same
      // gesture the Cmd/Ctrl+scroll shortcut produces.
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.01);
        editor.zoomAtPoint(at, editor.viewport.zoom * factor);
      } else if (event.shiftKey) {
        editor.panBy(-(event.deltaY || event.deltaX), 0);
      } else {
        editor.panBy(-event.deltaX, -event.deltaY);
      }
    },
    { passive: false },
  );

  // --- Keyboard -------------------------------------------------------------

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && libraryPanel.isOpen) {
      libraryPanel.hide();
      return;
    }
    if (event.key === "Escape" && help.isOpen) {
      help.hide();
      return;
    }
    if (isTextEntryTarget(event.target)) return;

    if (event.key === " " && !event.repeat) {
      engine.setModifiers({ space: true });
      event.preventDefault();
      return;
    }
    engine.setModifiers({ shift: event.shiftKey, alt: event.altKey, meta: event.metaKey || event.ctrlKey });

    // Escape aborts an in-flight gesture before it means "deselect".
    if (event.key === "Escape" && engine.isDragging) {
      engine.cancel();
      event.preventDefault();
      return;
    }
    if (event.key === "?" && event.shiftKey) {
      help.toggle();
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && editor.selection.length === 1) {
      const id = editor.selection[0]!;
      if (textEditor.begin(id)) {
        event.preventDefault();
        return;
      }
    }

    if (dispatchShortcut(event, context())) event.preventDefault();
  });

  window.addEventListener("keyup", (event) => {
    if (event.key === " ") engine.setModifiers({ space: false });
    engine.setModifiers({ shift: event.shiftKey, alt: event.altKey, meta: event.metaKey || event.ctrlKey });
  });

  // Releasing focus mid-drag would otherwise leave space-pan stuck on.
  window.addEventListener("blur", () => engine.setModifiers({ space: false, shift: false, alt: false, meta: false }));

  // --- Files: import, export, drop, paste -----------------------------------

  function exportDocument(): void {
    const blob = new Blob([toJSON(editor.doc)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = el("a", { href: url, download: "figma-lite-document.json" });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toasts.show("Exported JSON");
  }

  function loadText(text: string): void {
    try {
      const { doc, warnings } = fromJSON(text);
      editor.load(doc);
      engine.syncScope();
      editor.zoomToFit();
      for (const warning of warnings.slice(0, 3)) toasts.show(warning, "warn", 5000);
      if (warnings.length === 0) toasts.show("Imported");
    } catch (error) {
      const message = error instanceof ImportError ? error.message : "Could not read that file.";
      toasts.show(message, "warn", 5000);
    }
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    loadText(await file.text());
    fileInput.value = "";
  });

  imageInput.addEventListener("change", async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    await insertImageFile(editor, file, engine.scopeId, context().viewportCenterWorld());
    imageInput.value = "";
  });

  canvasHost.addEventListener("dragover", (event) => {
    event.preventDefault();
    canvasHost.classList.add("is-drop-target");
  });
  canvasHost.addEventListener("dragleave", (event) => {
    if (!canvasHost.contains(event.relatedTarget as Node)) canvasHost.classList.remove("is-drop-target");
  });
  canvasHost.addEventListener("drop", async (event) => {
    event.preventDefault();
    canvasHost.classList.remove("is-drop-target");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const at = editor.toWorld(pointerPos(event));
    if (file.type === "application/json" || file.name.endsWith(".json")) loadText(await file.text());
    else await insertImageFile(editor, file, engine.scopeId, at);
  });

  window.addEventListener("paste", async (event) => {
    if (isTextEntryTarget(event.target) || textEditor.isEditing) return;
    const file = [...(event.clipboardData?.files ?? [])][0];
    if (file?.type.startsWith("image/")) {
      event.preventDefault();
      await insertImageFile(editor, file, engine.scopeId, context().viewportCenterWorld());
      return;
    }
    const text = event.clipboardData?.getData("text/plain");
    if (text) {
      event.preventDefault();
      // Route through the clipboard module so the payload check lives in one place.
      const handled = await paste(editor, engine.scopeId);
      if (!handled) toasts.show("Nothing to paste");
    }
  });

  // --- Autosave and the document library -----------------------------------

  // The active document is written to IndexedDB shortly after the last change.
  // History, selection and viewport are deliberately not persisted: restoring
  // an undo stack that no longer matches what the user remembers doing is worse
  // than starting clean.
  //
  // The library writes only the nodes that changed since its last successful
  // save, so autosaving a 5,000-node document costs the same as a 5-node one.
  let autosaveTimer: number | undefined;
  let autosaveWarned = false;

  function queueAutosave(): void {
    if (!library || !activeId) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void saveNow(), AUTOSAVE_DEBOUNCE_MS) as unknown as number;
  }

  async function saveNow(): Promise<void> {
    clearTimeout(autosaveTimer);
    if (!library || !activeId) return;
    try {
      await library.save(activeId, editor.doc);
      autosaveWarned = false;
      if (libraryPanel.isOpen) await refreshLibrary();
    } catch {
      // Quota exhaustion or a storage failure. Dropping this silently would let
      // someone work for an hour and lose it on refresh, so say so once and
      // point at the export, which has no size limit.
      if (autosaveWarned) return;
      autosaveWarned = true;
      toasts.show("Could not autosave — export to JSON to keep this work", "warn", 6000);
    }
  }

  async function refreshLibrary(): Promise<void> {
    if (!library) return;
    const [documents, usage] = await Promise.all([library.list(), library.estimate()]);
    libraryPanel.render(documents, activeId, usage, Date.now());
  }

  async function showLibrary(): Promise<void> {
    await saveNow();
    await refreshLibrary();
    libraryPanel.show();
  }

  /** Loads a saved design, after flushing whatever is on screen right now. */
  async function openDocument(id: string): Promise<void> {
    if (!library || id === activeId) return;
    await saveNow();

    const doc = await library.load(id);
    if (!doc) {
      toasts.show("That design could not be opened", "warn");
      return;
    }
    activeId = id;
    await library.setActiveId(id);

    editor.load(doc);
    engine.syncScope();
    editor.zoomToFit();
    await syncDocumentName();
    await refreshLibrary();
  }

  async function createDocument(fromSample = false): Promise<void> {
    if (!library) return;
    await saveNow();

    const existing = await library.list();
    const summary = await library.create(
      uniqueName("Untitled", existing.map((d) => d.name)),
      fromSample ? sampleDocument() : emptyDocument(),
    );
    activeId = summary.id;
    await library.setActiveId(summary.id);

    // Read back rather than reusing the in-memory document, so the library's
    // diff base and the editor's document are the same object.
    editor.load((await library.load(summary.id)) ?? emptyDocument());
    engine.syncScope();
    editor.zoomToFit();
    await syncDocumentName();
    await refreshLibrary();
  }

  async function renameDocument(id: string, name: string): Promise<void> {
    if (!library) return;
    await library.rename(id, name);
    if (id === activeId) await syncDocumentName();
    await refreshLibrary();
  }

  async function removeDocument(id: string): Promise<void> {
    if (!library) return;
    await library.remove(id);

    if (id !== activeId) {
      await refreshLibrary();
      return;
    }
    // The open design was deleted: fall through to the next one, or start over.
    activeId = null;
    const remaining = await library.list();
    if (remaining[0]) await openDocument(remaining[0].id);
    else await createDocument(true);
  }

  async function clearLibrary(): Promise<void> {
    if (!library) return;
    clearTimeout(autosaveTimer);
    await library.clearAll();
    activeId = null;
    await createDocument(true);
    toasts.show("Cleared all saved data");
  }

  async function syncDocumentName(): Promise<void> {
    if (!library || !activeId) return;
    const summary = (await library.list()).find((d) => d.id === activeId);
    toolbar.setDocumentName(summary?.name ?? "Untitled");
  }

  // --- Start ----------------------------------------------------------------

  // The shell is already on screen; the document arrives a frame later. Opening
  // the library is async, which is the one real cost of leaving localStorage —
  // and it buys a quota measured in gigabytes instead of five megabytes.
  const opened = await openLibrary();
  library = opened.library;

  const summaries = await library.list();
  const storedActive = await library.activeId();
  const startId = summaries.some((d) => d.id === storedActive) ? storedActive : summaries[0]?.id ?? null;

  if (startId) {
    const doc = await library.load(startId);
    if (doc) {
      activeId = startId;
      editor.load(doc);
      await library.setActiveId(startId);
      await syncDocumentName();
    }
  }
  if (!activeId) {
    // First run, or every design was deleted: open the starter scene.
    await createDocument(true);
  }

  if (opened.migrated) toasts.show("Moved your saved work into IndexedDB");
  if (library.kind !== "indexeddb") {
    toasts.show("IndexedDB unavailable — storage is limited", "warn", 5000);
  }

  resize();
  editor.zoomToFit();
  toolbar.render();
  layers.render();
  properties.render(true);
  schedule();

  // Expose for console poking; handy when discussing the model.
  Object.assign(window as unknown as Record<string, unknown>, {
    editor,
    engine,
    debug: {
      deepWorldBounds,
      toJSON: () => toJSON(editor.doc),
      storageKind: () => library?.kind ?? null,
      commands: { insertNode },
      estimate: () => library?.estimate() ?? null,
      listDocuments: () => library?.list() ?? Promise.resolve([]),
      activeDocumentId: () => activeId,
      clearStorage: () => library?.clearAll(),
      saveNow: () => saveNow(),
    },
  });
}

const STORE_LABEL: Record<string, string> = {
  indexeddb: "IndexedDB",
  localstorage: "localStorage",
  memory: "memory only",
};

void boot();
