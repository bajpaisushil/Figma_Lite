/**
 * The document model.
 *
 * Nodes are stored in one flat `Record<NodeId, Node>` and the tree is expressed
 * by `children: NodeId[]` on containers plus a `parent` back-pointer. Flat
 * storage keeps lookup O(1) and — more importantly — lets an edit clone only
 * the nodes it actually touches, so undo can diff two documents by reference
 * comparison instead of deep equality. See `history.ts`.
 *
 * Every node is *immutable*. Never mutate a node in place; produce a new one.
 */

export type NodeId = string;

export type NodeType = "frame" | "group" | "rect" | "ellipse" | "text" | "image";

export interface Paint {
  /** CSS color. `none` is expressed by omitting the paint entirely. */
  color: string;
}

/** Fields shared by every node. `x/y/w/h/rotation` are in *parent* space. */
export interface NodeBase {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly name: string;
  readonly parent: NodeId | null;
  /** Top-left of the unrotated box, in parent coordinates. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Radians, applied about the box centre. */
  readonly rotation: number;
  readonly opacity: number;
  readonly visible: boolean;
  readonly locked: boolean;
}

export interface ContainerFields {
  readonly children: readonly NodeId[];
}

export interface StrokeFields {
  readonly fill?: Paint;
  readonly stroke?: Paint;
  readonly strokeWidth: number;
}

export interface FrameNode extends NodeBase, ContainerFields, StrokeFields {
  readonly type: "frame";
  readonly radius: number;
  /** Frames clip their children, like Figma. Groups do not. */
  readonly clip: boolean;
}

export interface GroupNode extends NodeBase, ContainerFields {
  readonly type: "group";
}

export interface RectNode extends NodeBase, StrokeFields {
  readonly type: "rect";
  readonly radius: number;
}

export interface EllipseNode extends NodeBase, StrokeFields {
  readonly type: "ellipse";
}

export type TextAlign = "left" | "center" | "right";

export interface TextNode extends NodeBase {
  readonly type: "text";
  readonly text: string;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly lineHeight: number;
  readonly align: TextAlign;
  readonly color: string;
}

export interface ImageNode extends NodeBase, StrokeFields {
  readonly type: "image";
  /** A data: URL, so a document is self-contained when exported to JSON. */
  readonly src: string;
  readonly radius: number;
  readonly fit: "fill" | "contain" | "cover";
}

export type SceneNode = FrameNode | GroupNode | RectNode | EllipseNode | TextNode | ImageNode;
export type ContainerNode = FrameNode | GroupNode;

export interface Document {
  readonly nodes: Readonly<Record<NodeId, SceneNode>>;
  /** The page: a frame that is never selectable, deletable or rendered itself. */
  readonly root: NodeId;
}

export function isContainer(node: SceneNode): node is ContainerNode {
  return node.type === "frame" || node.type === "group";
}

export function hasStroke(node: SceneNode): node is FrameNode | RectNode | EllipseNode | ImageNode {
  return node.type === "frame" || node.type === "rect" || node.type === "ellipse" || node.type === "image";
}

export function hasRadius(node: SceneNode): node is FrameNode | RectNode | ImageNode {
  return node.type === "frame" || node.type === "rect" || node.type === "image";
}
