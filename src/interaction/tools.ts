/**
 * The interaction engine.
 *
 * An explicit state machine over pointer events. At any moment exactly one
 * gesture is active, and each gesture owns the document snapshot it started
 * from. Every frame recomputes the result from *that snapshot* rather than
 * accumulating deltas onto the live document — so a drag cannot drift, and
 * releasing a modifier mid-gesture re-derives the correct answer instead of
 * trying to undo a previous increment.
 *
 *   idle ──pointerdown──▶ press ──move past threshold──▶ move / marquee / create
 *     ▲                     │                                     │
 *     └──────pointerup──────┴─────────────────────────────────────┘
 *
 * Resize and rotate are entered directly from a handle hit, skipping `press`.
 */

import type { Document, NodeId, NodeType, SceneNode } from "../core/types.ts";
import type { Editor, ToolId } from "../core/editor.ts";
import {
  MIN_SIZE,
  cloneNodes,
  deleteNodes,
  insertNode,
  resizedBox,
  rotateNodesAbout,
  scaleNodesAbout,
  translateNodes,
  updateNode,
} from "../core/commands.ts";
import { createNode } from "../core/factory.ts";
import { defaultName, localTransform, unionWorldBounds, worldTransform } from "../core/document.ts";
import {
  type Rect,
  type Vec2,
  apply,
  applyVector,
  invert,
  normalizeAngle,
  rectFromPoints,
  rotation as rotationMat,
  round,
  toDegrees,
} from "../core/math.ts";
import {
  type ResizeHandle,
  HANDLE_UNIT,
  OPPOSITE_HANDLE,
  handleAtPoint,
  rotationHandleAtPoint,
  selectionFrame,
} from "../render/overlay.ts";
import { type SnapGuide, computeSnap } from "./snapping.ts";
import { drillTarget, hitTest, marqueeHits, resolveSelectionTarget } from "./hittest.ts";

/** Screen-space distance the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 3;
const ROTATE_SNAP_DEGREES = 15;

export interface Modifiers {
  shift: boolean;
  alt: boolean;
  meta: boolean;
  space: boolean;
}

type Gesture =
  | { kind: "idle" }
  | { kind: "pan"; lastScreen: Vec2 }
  | {
      kind: "press";
      originScreen: Vec2;
      originWorld: Vec2;
      hitId: NodeId | null;
      additive: boolean;
    }
  | { kind: "marquee"; originScreen: Vec2; additive: boolean; baseSelection: NodeId[] }
  | {
      kind: "move";
      startDoc: Document;
      originWorld: Vec2;
      ids: NodeId[];
      startBounds: Rect;
      duplicated: boolean;
    }
  | {
      kind: "resize";
      startDoc: Document;
      handle: ResizeHandle;
      ids: NodeId[];
      /** Single-node path: the node as it was when the gesture began. */
      startNode: SceneNode | null;
      /** Multi-node path: the world AABB at gesture start. */
      startBounds: Rect;
    }
  | {
      kind: "rotate";
      startDoc: Document;
      ids: NodeId[];
      pivotWorld: Vec2;
      startAngle: number;
      baseRotation: number;
    }
  | { kind: "create"; startDoc: Document; nodeId: NodeId; type: NodeType; originWorld: Vec2 };

export interface InteractionHost {
  /** Called whenever transient overlay state changes. */
  onOverlayChange: () => void;
  /** Requests the text editor for a node; returns false if not editable. */
  beginTextEdit: (id: NodeId) => boolean;
  setCursor: (cursor: string) => void;
}

export class InteractionEngine {
  private gesture: Gesture = { kind: "idle" };
  private modifiers: Modifiers = { shift: false, alt: false, meta: false, space: false };
  private lastPointer: Vec2 = { x: 0, y: 0 };

  /** Transient state the overlay reads each frame. */
  marquee: Rect | null = null;
  guides: SnapGuide[] = [];
  badge: string | null = null;
  scopeId: NodeId;

  snapEnabled = true;

  constructor(
    private readonly editor: Editor,
    private readonly host: InteractionHost,
  ) {
    this.scopeId = editor.doc.root;
  }

  get state(): Gesture["kind"] {
    return this.gesture.kind;
  }

  get isDragging(): boolean {
    return this.gesture.kind !== "idle" && this.gesture.kind !== "press";
  }

  setModifiers(mods: Partial<Modifiers>): void {
    const before = { ...this.modifiers };
    Object.assign(this.modifiers, mods);
    // Holding shift mid-drag must change the result immediately, so replay the
    // last pointer position through the active gesture.
    if (
      this.isDragging &&
      (before.shift !== this.modifiers.shift || before.alt !== this.modifiers.alt)
    ) {
      this.updateGesture(this.lastPointer);
    }
    if (before.space !== this.modifiers.space) this.updateCursor(this.lastPointer);
  }

  /** Resets scope when the document is replaced or the scope node disappears. */
  syncScope(): void {
    if (!this.editor.doc.nodes[this.scopeId]) this.scopeId = this.editor.doc.root;
  }

  setScope(id: NodeId): void {
    if (this.scopeId === id) return;
    this.scopeId = id;
    this.host.onOverlayChange();
  }

  exitScope(): boolean {
    if (this.scopeId === this.editor.doc.root) return false;
    const parent = this.editor.doc.nodes[this.scopeId]?.parent ?? this.editor.doc.root;
    this.editor.setSelection([this.scopeId]);
    this.setScope(parent);
    return true;
  }

  // --- Pointer ------------------------------------------------------------

  pointerDown(screen: Vec2, button: number): void {
    this.lastPointer = screen;
    const editor = this.editor;
    const world = editor.toWorld(screen);

    // Panning pre-empts everything: middle mouse, space-drag, or the hand tool.
    if (button === 1 || this.modifiers.space || editor.tool === "hand") {
      this.gesture = { kind: "pan", lastScreen: screen };
      this.host.setCursor("grabbing");
      return;
    }
    if (button !== 0) return;

    if (editor.tool !== "select") {
      this.beginCreate(world, editor.tool);
      return;
    }

    // Handles take priority over whatever sits beneath them.
    const frame = selectionFrame(editor.doc, editor.selection, editor.viewport);
    if (frame) {
      const resize = handleAtPoint(frame, screen);
      if (resize) return this.beginResize(resize);
      const rotate = rotationHandleAtPoint(frame, screen);
      if (rotate) return this.beginRotate(world);
    }

    const hit = hitTest(editor.doc, world);
    const target = hit ? resolveSelectionTarget(editor.doc, hit, this.scopeId) : null;

    this.gesture = {
      kind: "press",
      originScreen: screen,
      originWorld: world,
      hitId: target,
      additive: this.modifiers.shift,
    };

    if (target) {
      if (this.modifiers.shift) {
        editor.toggleSelection(target);
      } else if (!editor.isSelected(target)) {
        editor.setSelection([target]);
      }
    } else if (!this.modifiers.shift) {
      editor.clearSelection();
    }
  }

  pointerMove(screen: Vec2): void {
    this.lastPointer = screen;
    if (this.gesture.kind === "idle") {
      this.updateHover(screen);
      this.updateCursor(screen);
      return;
    }
    this.updateGesture(screen);
  }

  private updateGesture(screen: Vec2): void {
    const editor = this.editor;
    const g = this.gesture;

    switch (g.kind) {
      case "pan": {
        editor.panBy(screen.x - g.lastScreen.x, screen.y - g.lastScreen.y);
        this.gesture = { kind: "pan", lastScreen: screen };
        return;
      }

      case "press": {
        const travelled = Math.hypot(screen.x - g.originScreen.x, screen.y - g.originScreen.y);
        if (travelled < DRAG_THRESHOLD) return;
        // The press has become a drag: either move the selection or marquee.
        if (g.hitId && editor.selection.length > 0) this.beginMove(g.originWorld);
        else this.beginMarquee(g.originScreen, g.additive);
        this.updateGesture(screen);
        return;
      }

      case "marquee": {
        const rect = rectFromPoints(g.originScreen, screen);
        this.marquee = rect;
        const worldRect = rectFromPoints(editor.toWorld(g.originScreen), editor.toWorld(screen));
        const hits = marqueeHits(editor.doc, worldRect, this.scopeId);
        editor.setSelection(g.additive ? [...g.baseSelection, ...hits] : hits);
        this.host.onOverlayChange();
        return;
      }

      case "move":
        return this.updateMove(g, screen);

      case "resize":
        return this.updateResize(g, screen);

      case "rotate":
        return this.updateRotate(g, screen);

      case "create":
        return this.updateCreate(g, screen);

      case "idle":
        return;
    }
  }

  pointerUp(): void {
    const g = this.gesture;
    this.gesture = { kind: "idle" };
    this.marquee = null;
    this.guides = [];
    this.badge = null;

    switch (g.kind) {
      case "move":
      case "resize":
      case "rotate":
        this.editor.end();
        break;
      case "create":
        this.finishCreate(g);
        break;
      case "press":
        // A click with no drag: if it landed on an already-multi-selected node
        // without shift, collapse the selection to just that node.
        if (g.hitId && !g.additive && this.editor.selection.length > 1) {
          this.editor.setSelection([g.hitId]);
        }
        break;
      default:
        break;
    }
    this.host.onOverlayChange();
    this.updateCursor(this.lastPointer);
  }

  /** Aborts the gesture in flight, restoring the document to its start state. */
  cancel(): void {
    const g = this.gesture;
    this.gesture = { kind: "idle" };
    this.marquee = null;
    this.guides = [];
    this.badge = null;
    if (g.kind === "move" || g.kind === "resize" || g.kind === "rotate" || g.kind === "create") {
      this.editor.cancel();
    }
    this.host.onOverlayChange();
  }

  doubleClick(screen: Vec2): void {
    const editor = this.editor;
    const world = editor.toWorld(screen);
    const hit = hitTest(editor.doc, world);
    if (!hit) {
      // Double-clicking empty canvas steps back out one level.
      this.exitScope();
      return;
    }

    const node = editor.doc.nodes[hit];
    if (node?.type === "text" && this.host.beginTextEdit(hit)) return;

    const drill = drillTarget(editor.doc, hit, this.scopeId);
    if (drill && drill !== this.scopeId) {
      this.setScope(drill);
      editor.setSelection([hit]);
      return;
    }
    editor.setSelection([hit]);
  }

  // --- Move ---------------------------------------------------------------

  private beginMarquee(originScreen: Vec2, additive: boolean): void {
    this.gesture = {
      kind: "marquee",
      originScreen,
      additive,
      // Shift-marquee adds to whatever was already selected, so remember it.
      baseSelection: additive ? [...this.editor.selection] : [],
    };
  }

  private beginMove(originWorld: Vec2): void {
    const editor = this.editor;
    const ids = [...editor.selection];
    const bounds = unionWorldBounds(editor.doc, ids);
    if (!bounds) return;

    editor.begin("Move");

    // Alt-drag duplicates: clone up front, then drag the clones.
    let duplicated = false;
    let movingIds = ids;
    if (this.modifiers.alt) {
      const result = cloneNodes(editor.doc, ids);
      editor.live(() => result.doc);
      editor.setSelection(result.ids);
      movingIds = result.ids;
      duplicated = true;
    }

    this.gesture = {
      kind: "move",
      startDoc: editor.doc,
      originWorld,
      ids: movingIds,
      startBounds: bounds,
      duplicated,
    };
  }

  private updateMove(g: Extract<Gesture, { kind: "move" }>, screen: Vec2): void {
    const editor = this.editor;
    const world = editor.toWorld(screen);
    let dx = world.x - g.originWorld.x;
    let dy = world.y - g.originWorld.y;

    // Shift locks to the dominant axis.
    if (this.modifiers.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }

    const moved: Rect = { ...g.startBounds, x: g.startBounds.x + dx, y: g.startBounds.y + dy };
    const snap = computeSnap(editor.doc, moved, g.ids, this.scopeId, {
      zoom: editor.viewport.zoom,
      enabled: this.snapEnabled && !this.modifiers.meta,
    });

    // Never let a snap break an axis lock the user explicitly asked for.
    const sdx = this.modifiers.shift && dx === 0 ? 0 : snap.dx;
    const sdy = this.modifiers.shift && dy === 0 ? 0 : snap.dy;

    this.guides = snap.guides;
    this.badge = `${round(moved.x + sdx)}, ${round(moved.y + sdy)}`;
    editor.live(() => translateNodes(g.startDoc, g.ids, dx + sdx, dy + sdy));
    this.host.onOverlayChange();
  }

  // --- Resize -------------------------------------------------------------

  private beginResize(handle: ResizeHandle): void {
    const editor = this.editor;
    const ids = [...editor.selection];
    const bounds = unionWorldBounds(editor.doc, ids);
    if (!bounds) return;

    editor.begin("Resize");
    this.gesture = {
      kind: "resize",
      startDoc: editor.doc,
      handle,
      ids,
      startNode: ids.length === 1 ? (editor.doc.nodes[ids[0]!] ?? null) : null,
      startBounds: bounds,
    };
  }

  private updateResize(g: Extract<Gesture, { kind: "resize" }>, screen: Vec2): void {
    const editor = this.editor;
    const world = editor.toWorld(screen);
    const fromCenter = this.modifiers.alt;
    const keepAspect = this.modifiers.shift;

    if (g.startNode) {
      this.resizeSingle(g, g.startNode, world, fromCenter, keepAspect);
    } else {
      this.resizeMany(g, world, fromCenter, keepAspect);
    }
    this.host.onOverlayChange();
  }

  /**
   * Single-node resize, done entirely in the node's *parent* space so that
   * rotation is handled by un-rotating the drag vector rather than by special
   * cases. The anchor (the opposite handle, or the centre when alt is held)
   * stays pinned; `resizedBox` then rebuilds x/y for the new size.
   */
  private resizeSingle(
    g: Extract<Gesture, { kind: "resize" }>,
    startNode: SceneNode,
    world: Vec2,
    fromCenter: boolean,
    keepAspect: boolean,
  ): void {
    const editor = this.editor;
    const parentId = startNode.parent;
    const parentWorld =
      parentId && parentId !== g.startDoc.root ? worldTransform(g.startDoc, parentId) : null;
    const toParent = parentWorld ? invert(parentWorld) : null;
    const pointerParent = toParent ? apply(toParent, world) : world;

    const handleUnit = HANDLE_UNIT[g.handle];
    const anchorUnit = fromCenter ? { x: 0.5, y: 0.5 } : HANDLE_UNIT[OPPOSITE_HANDLE[g.handle]];

    // Where the anchor sits in parent space, from the *original* node.
    const anchorParent = apply(localTransform(startNode), {
      x: anchorUnit.x * startNode.w,
      y: anchorUnit.y * startNode.h,
    });

    // Un-rotate the drag vector into the node's own axes.
    const local = applyVector(rotationMat(-startNode.rotation), {
      x: pointerParent.x - anchorParent.x,
      y: pointerParent.y - anchorParent.y,
    });

    const gain = fromCenter ? 2 : 1;
    let w = startNode.w;
    let h = startNode.h;
    if (handleUnit.x !== 0.5) w = Math.max(MIN_SIZE, (handleUnit.x === 1 ? 1 : -1) * local.x * gain);
    if (handleUnit.y !== 0.5) h = Math.max(MIN_SIZE, (handleUnit.y === 1 ? 1 : -1) * local.y * gain);

    if (keepAspect && startNode.w > 0 && startNode.h > 0) {
      const ratio = startNode.w / startNode.h;
      // Corner handles scale by the larger change; edge handles drive the other axis.
      if (handleUnit.x !== 0.5 && handleUnit.y !== 0.5) {
        if (w / ratio > h) h = w / ratio;
        else w = h * ratio;
      } else if (handleUnit.x !== 0.5) {
        h = w / ratio;
      } else {
        w = h * ratio;
      }
    }

    const box = resizedBox(startNode, anchorUnit, w, h);
    this.badge = `${round(box.w)} × ${round(box.h)}`;
    editor.live(() => updateNode(g.startDoc, startNode.id, box));
  }

  /**
   * Multi-node resize: scale everything about the anchor corner of the
   * selection's axis-aligned box, which is what a shared bounding box implies.
   */
  private resizeMany(
    g: Extract<Gesture, { kind: "resize" }>,
    world: Vec2,
    fromCenter: boolean,
    keepAspect: boolean,
  ): void {
    const editor = this.editor;
    const b = g.startBounds;
    const handleUnit = HANDLE_UNIT[g.handle];
    const anchorUnit = fromCenter ? { x: 0.5, y: 0.5 } : HANDLE_UNIT[OPPOSITE_HANDLE[g.handle]];

    const anchor = { x: b.x + anchorUnit.x * b.w, y: b.y + anchorUnit.y * b.h };
    const startHandle = { x: b.x + handleUnit.x * b.w, y: b.y + handleUnit.y * b.h };

    let sx = 1;
    let sy = 1;
    if (handleUnit.x !== 0.5) {
      const denom = startHandle.x - anchor.x;
      if (Math.abs(denom) > 1e-6) sx = (world.x - anchor.x) / denom;
    }
    if (handleUnit.y !== 0.5) {
      const denom = startHandle.y - anchor.y;
      if (Math.abs(denom) > 1e-6) sy = (world.y - anchor.y) / denom;
    }

    if (keepAspect) {
      const s = handleUnit.x !== 0.5 && handleUnit.y !== 0.5 ? Math.max(sx, sy) : Math.max(sx, sy);
      if (handleUnit.x !== 0.5) sx = s;
      if (handleUnit.y !== 0.5) sy = s;
    }

    // Scaling through zero would collapse and mirror the selection.
    sx = Math.max(sx, 0.001);
    sy = Math.max(sy, 0.001);

    this.badge = `${round(b.w * sx)} × ${round(b.h * sy)}`;
    editor.live(() => scaleNodesAbout(g.startDoc, g.ids, anchor, sx, sy));
  }

  // --- Rotate -------------------------------------------------------------

  private beginRotate(world: Vec2): void {
    const editor = this.editor;
    const ids = [...editor.selection];
    const bounds = unionWorldBounds(editor.doc, ids);
    if (!bounds) return;

    const pivot = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    const first = ids.length === 1 ? editor.doc.nodes[ids[0]!] : null;

    editor.begin("Rotate");
    this.gesture = {
      kind: "rotate",
      startDoc: editor.doc,
      ids,
      pivotWorld: pivot,
      startAngle: Math.atan2(world.y - pivot.y, world.x - pivot.x),
      baseRotation: first?.rotation ?? 0,
    };
  }

  private updateRotate(g: Extract<Gesture, { kind: "rotate" }>, screen: Vec2): void {
    const editor = this.editor;
    const world = editor.toWorld(screen);
    const angle = Math.atan2(world.y - g.pivotWorld.y, world.x - g.pivotWorld.x);
    let delta = normalizeAngle(angle - g.startAngle);

    if (this.modifiers.shift) {
      // Snap the *absolute* angle, so shift-rotate lands on exact multiples.
      const step = (ROTATE_SNAP_DEGREES * Math.PI) / 180;
      const absolute = g.baseRotation + delta;
      delta = Math.round(absolute / step) * step - g.baseRotation;
    }

    this.badge = `${round(toDegrees(normalizeAngle(g.baseRotation + delta)), 1)}°`;
    editor.live(() => rotateNodesAbout(g.startDoc, g.ids, g.pivotWorld, delta));
    this.host.onOverlayChange();
  }

  // --- Create -------------------------------------------------------------

  private beginCreate(world: Vec2, tool: Exclude<ToolId, "select" | "hand">): void {
    const editor = this.editor;
    const type: NodeType = tool;
    const parentId = this.scopeId;
    const parentM = parentId === editor.doc.root ? null : worldTransform(editor.doc, parentId);
    const localOrigin = parentM ? apply(invert(parentM), world) : world;

    const node = createNode(type, {
      name: defaultName(editor.doc, type),
      box: { x: localOrigin.x, y: localOrigin.y, w: 1, h: 1 },
    });

    editor.begin(`Create ${type}`);
    editor.live((doc) => insertNode(doc, node, { parent: parentId }));
    editor.setSelection([node.id]);

    this.gesture = { kind: "create", startDoc: editor.doc, nodeId: node.id, type, originWorld: world };
  }

  private updateCreate(g: Extract<Gesture, { kind: "create" }>, screen: Vec2): void {
    const editor = this.editor;
    const world = editor.toWorld(screen);
    const node = editor.doc.nodes[g.nodeId];
    if (!node) return;

    const parentId = node.parent;
    const parentM = parentId && parentId !== editor.doc.root ? worldTransform(editor.doc, parentId) : null;
    const toParent = parentM ? invert(parentM) : null;
    const a = toParent ? apply(toParent, g.originWorld) : g.originWorld;
    const b = toParent ? apply(toParent, world) : world;

    let box = rectFromPoints(a, b);
    if (this.modifiers.shift) {
      const side = Math.max(box.w, box.h);
      box = {
        x: b.x < a.x ? a.x - side : a.x,
        y: b.y < a.y ? a.y - side : a.y,
        w: side,
        h: side,
      };
    }

    this.badge = `${round(box.w)} × ${round(box.h)}`;
    editor.live((doc) =>
      updateNode(doc, g.nodeId, {
        x: box.x,
        y: box.y,
        w: Math.max(box.w, MIN_SIZE),
        h: Math.max(box.h, MIN_SIZE),
      }),
    );
    this.host.onOverlayChange();
  }

  private finishCreate(g: Extract<Gesture, { kind: "create" }>): void {
    const editor = this.editor;
    const node = editor.doc.nodes[g.nodeId];
    if (!node) {
      editor.end();
      return;
    }

    // A click without a drag means "give me a default-sized one here".
    if (node.w <= 2 || node.h <= 2) {
      const defaults = DEFAULT_SIZES[g.type];
      editor.live((doc) =>
        updateNode(doc, g.nodeId, {
          x: node.x - defaults.w / 2,
          y: node.y - defaults.h / 2,
          w: defaults.w,
          h: defaults.h,
        }),
      );
    }
    editor.end(`Create ${g.type}`);
    editor.setTool("select");

    if (g.type === "text") this.host.beginTextEdit(g.nodeId);
  }

  /** Removes a node that was created but never committed (e.g. failed import). */
  discard(id: NodeId): void {
    this.editor.commit("Delete", (doc) => deleteNodes(doc, [id]));
  }

  // --- Hover and cursor ---------------------------------------------------

  private updateHover(screen: Vec2): void {
    const editor = this.editor;
    const world = editor.toWorld(screen);
    const hit = hitTest(editor.doc, world);
    editor.setHover(hit ? resolveSelectionTarget(editor.doc, hit, this.scopeId) : null);
  }

  private updateCursor(screen: Vec2): void {
    const editor = this.editor;
    if (this.modifiers.space || editor.tool === "hand") {
      this.host.setCursor(this.isDragging ? "grabbing" : "grab");
      return;
    }
    if (editor.tool !== "select") {
      this.host.setCursor("crosshair");
      return;
    }

    const frame = selectionFrame(editor.doc, editor.selection, editor.viewport);
    if (frame) {
      const resize = handleAtPoint(frame, screen);
      if (resize) return this.host.setCursor(resizeCursor(resize, frame.rotation));
      if (rotationHandleAtPoint(frame, screen)) return this.host.setCursor("grab");
    }
    this.host.setCursor(editor.hoverId ? "move" : "default");
  }
}

const DEFAULT_SIZES: Record<NodeType, { w: number; h: number }> = {
  frame: { w: 320, h: 240 },
  group: { w: 120, h: 120 },
  rect: { w: 140, h: 100 },
  ellipse: { w: 120, h: 120 },
  text: { w: 180, h: 32 },
  image: { w: 200, h: 200 },
};

/** Picks the cursor whose arrow points along the handle's outward normal. */
export function resizeCursor(handle: ResizeHandle, frameRotation: number): string {
  const base: Record<ResizeHandle, number> = {
    e: 0,
    se: 45,
    s: 90,
    sw: 135,
    w: 180,
    nw: 225,
    n: 270,
    ne: 315,
  };
  const angle = (base[handle] + toDegrees(frameRotation) + 360) % 180;
  if (angle < 22.5 || angle >= 157.5) return "ew-resize";
  if (angle < 67.5) return "nwse-resize";
  if (angle < 112.5) return "ns-resize";
  return "nesw-resize";
}
