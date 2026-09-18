/**
 * Vector PDF export, written by hand.
 *
 * Shapes become PDF path operators and text becomes real text, so the result
 * scales without pixelating, prints properly, and stays selectable and
 * searchable. That is the whole reason to offer PDF alongside PNG — a PDF that
 * is just a picture is a worse PNG.
 *
 * Two coordinate quirks drive most of the code:
 *
 *  - PDF's origin is bottom-left with Y up, while the document (and every other
 *    part of this editor) is top-left with Y down. The page content opens with
 *    a `1 0 0 -1 0 H cm` flip so node transforms can be emitted unchanged.
 *  - Glyphs drawn under that flip would come out upside down, so each text run
 *    re-flips locally via its text matrix.
 *
 * Known limits, all noted where they apply: fonts are the PDF standard 14
 * (custom families are substituted), and images are re-encoded to JPEG, so
 * transparency is composited onto white.
 */

import type { Document, NodeId, SceneNode, TextNode } from "../core/types.ts";
import { isContainer } from "../core/types.ts";
import { ancestorsOf, localTransform, worldTransform } from "../core/document.ts";
import { type Mat, type Rect, apply } from "../core/math.ts";
import { layoutText } from "../render/text.ts";
import { ByteBuilder, dataUrlToBytes } from "./bytes.ts";
import { num, parseColor } from "./color.ts";

/** Bezier circle constant: how far control points sit along the tangent. */
const KAPPA = 0.5522847498;
/** Canvas draws text from the em-box top; PDF from the baseline. */
const BASELINE_RATIO = 0.8;

interface PdfObject {
  id: number;
  body: ByteBuilder;
}

interface EmbeddedImage {
  id: number;
  width: number;
  height: number;
}

export interface PdfExportOptions {
  /** World-space rectangle to export; becomes the page box. */
  bounds: Rect;
  /** Subtree roots to draw. Defaults to everything under the document root. */
  ids?: readonly NodeId[];
  /** Page background. Omit for a transparent page. */
  background?: string;
  title?: string;
}

class PdfBuilder {
  private objects: PdfObject[] = [];
  private nextId = 1;

  allocate(): number {
    return this.nextId++;
  }

  add(id: number, write: (out: ByteBuilder) => void): void {
    const body = new ByteBuilder();
    write(body);
    this.objects.push({ id, body });
  }

  /** Serialises the objects with a cross-reference table and trailer. */
  finish(rootId: number, infoId: number | null): Blob {
    const out = new ByteBuilder();
    out.text("%PDF-1.4\n");
    // A binary comment marks the file as containing 8-bit data, so naive tools
    // do not mangle the image streams as text.
    out.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const offsets = new Map<number, number>();
    const ordered = [...this.objects].sort((a, b) => a.id - b.id);
    for (const object of ordered) {
      offsets.set(object.id, out.offset);
      out.text(`${object.id} 0 obj\n`);
      out.bytes(object.body.toUint8Array());
      out.text("\nendobj\n");
    }

    const xrefOffset = out.offset;
    const count = this.nextId;
    out.text(`xref\n0 ${count}\n`);
    out.text("0000000000 65535 f \n");
    for (let id = 1; id < count; id++) {
      const offset = offsets.get(id) ?? 0;
      out.text(`${String(offset).padStart(10, "0")} 00000 n \n`);
    }

    out.text(`trailer\n<< /Size ${count} /Root ${rootId} 0 R`);
    if (infoId !== null) out.text(` /Info ${infoId} 0 R`);
    out.text(` >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return out.toBlob("application/pdf");
  }
}

/**
 * WinAnsi's 0x80-0x9F block holds the typographic punctuation Latin-1 lacks, so
 * curly quotes and dashes survive instead of becoming question marks.
 */
const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

/** Escapes a string for a PDF literal and maps it into WinAnsi. */
function pdfString(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "(" || char === ")" || char === "\\") {
      out += `\\${char}`;
    } else if (code < 32) {
      out += " ";
    } else if (code <= 255) {
      out += char;
    } else if (WIN_ANSI[code] !== undefined) {
      out += String.fromCharCode(WIN_ANSI[code]!);
    } else {
      out += "?"; // Genuinely unrepresentable without an embedded font.
    }
  }
  return out;
}

/** Appends a rounded-rectangle subpath in the current user space. */
function roundedRect(ops: string[], w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, Math.min(Math.abs(w), Math.abs(h)) / 2));
  if (r <= 0) {
    ops.push(`0 0 ${num(w)} ${num(h)} re`);
    return;
  }
  const k = KAPPA * r;
  ops.push(`${num(r)} 0 m`);
  ops.push(`${num(w - r)} 0 l`);
  ops.push(`${num(w - r + k)} 0 ${num(w)} ${num(r - k)} ${num(w)} ${num(r)} c`);
  ops.push(`${num(w)} ${num(h - r)} l`);
  ops.push(`${num(w)} ${num(h - r + k)} ${num(w - r + k)} ${num(h)} ${num(w - r)} ${num(h)} c`);
  ops.push(`${num(r)} ${num(h)} l`);
  ops.push(`${num(r - k)} ${num(h)} 0 ${num(h - r + k)} 0 ${num(h - r)} c`);
  ops.push(`0 ${num(r)} l`);
  ops.push(`0 ${num(r - k)} ${num(r - k)} 0 ${num(r)} 0 c`);
  ops.push("h");
}

/** Maps CSS object-fit onto a destination rectangle inside the node's box. */
function fitBox(
  fit: "fill" | "contain" | "cover",
  iw: number,
  ih: number,
  bw: number,
  bh: number,
): { x: number; y: number; w: number; h: number } {
  if (fit === "fill" || iw <= 0 || ih <= 0) return { x: 0, y: 0, w: bw, h: bh };
  const scale = fit === "cover" ? Math.max(bw / iw, bh / ih) : Math.min(bw / iw, bh / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

/**
 * A rounded rectangle with every point pre-mapped through `m`.
 *
 * Clip paths cannot be wrapped in their own q/Q — the Q would discard the clip
 * — and `cm` concatenates rather than replaces, so nesting transforms to place
 * each clip would compound them. Mapping the points instead keeps the current
 * transform untouched.
 */
function roundedRectThrough(ops: string[], w: number, h: number, radius: number, m: Mat): void {
  const local: string[] = [];
  roundedRect(local, w, h, radius);

  for (const op of local) {
    const parts = op.split(" ");
    const verb = parts[parts.length - 1]!;
    const values = parts.slice(0, -1).map(Number);

    if (verb === "h") {
      ops.push("h");
      continue;
    }
    if (verb === "re") {
      // Emit the axis-aligned rectangle as an explicit mapped quad instead.
      const [x, y, rw, rh] = values as [number, number, number, number];
      const corners = [
        { x, y },
        { x: x + rw, y },
        { x: x + rw, y: y + rh },
        { x, y: y + rh },
      ].map((p) => apply(m, p));
      ops.push(`${num(corners[0]!.x)} ${num(corners[0]!.y)} m`);
      for (const c of corners.slice(1)) ops.push(`${num(c.x)} ${num(c.y)} l`);
      ops.push("h");
      continue;
    }

    const mapped: string[] = [];
    for (let i = 0; i < values.length; i += 2) {
      const p = apply(m, { x: values[i]!, y: values[i + 1]! });
      mapped.push(num(p.x), num(p.y));
    }
    ops.push(`${mapped.join(" ")} ${verb}`);
  }
}

function ellipsePath(ops: string[], w: number, h: number): void {
  const rx = w / 2;
  const ry = h / 2;
  const cx = rx;
  const cy = ry;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;

  ops.push(`${num(cx + rx)} ${num(cy)} m`);
  ops.push(`${num(cx + rx)} ${num(cy + ky)} ${num(cx + kx)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`);
  ops.push(`${num(cx - kx)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ky)} ${num(cx - rx)} ${num(cy)} c`);
  ops.push(`${num(cx - rx)} ${num(cy - ky)} ${num(cx - kx)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`);
  ops.push(`${num(cx + kx)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ky)} ${num(cx + rx)} ${num(cy)} c`);
  ops.push("h");
}

/**
 * Decodes every image in the selection and re-encodes it as JPEG, which PDF can
 * embed directly with the DCTDecode filter. Transparency composites onto white
 * because baseline JPEG has no alpha channel.
 */
async function collectImages(
  doc: Document,
  ids: Iterable<NodeId>,
): Promise<Map<string, { bytes: Uint8Array; width: number; height: number }>> {
  const sources = new Set<string>();
  const visit = (id: NodeId) => {
    const node = doc.nodes[id];
    if (!node) return;
    if (node.type === "image" && node.src) sources.add(node.src);
    if (isContainer(node)) for (const child of node.children) visit(child);
  };
  for (const id of ids) visit(id);

  const out = new Map<string, { bytes: Uint8Array; width: number; height: number }>();
  for (const src of sources) {
    try {
      const image = await loadImage(src);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);

      const decoded = dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92));
      if (decoded) out.set(src, { bytes: decoded.bytes, width: canvas.width, height: canvas.height });
    } catch {
      // An image that will not decode is simply skipped; the rest still exports.
    }
  }
  return out;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode image"));
    image.src = src;
  });
}

export async function exportPdf(doc: Document, options: PdfExportOptions): Promise<Blob> {
  const { bounds } = options;
  const root = doc.nodes[doc.root];
  const ids =
    options.ids ?? (root && isContainer(root) ? root.children : ([] as readonly NodeId[]));

  const imageData = await collectImages(doc, ids);

  // A detached canvas provides the text metrics used for wrapping and
  // alignment. Measuring in Helvetica — the family the PDF will actually use —
  // keeps the line breaks close to what the reader renders.
  const measureCanvas = document.createElement("canvas");
  const measure = measureCanvas.getContext("2d")!;

  const pdf = new PdfBuilder();
  const catalogId = pdf.allocate();
  const pagesId = pdf.allocate();
  const pageId = pdf.allocate();
  const contentId = pdf.allocate();
  const infoId = pdf.allocate();

  const fonts = new Map<string, { id: number; name: string }>();
  const alphas = new Map<number, string>();
  const images = new Map<string, EmbeddedImage>();

  const fontRef = (weight: number): string => {
    const base = weight >= 600 ? "Helvetica-Bold" : "Helvetica";
    const existing = fonts.get(base);
    if (existing) return existing.name;
    const name = `F${fonts.size + 1}`;
    fonts.set(base, { id: pdf.allocate(), name });
    return name;
  };

  const alphaRef = (alpha: number): string => {
    const key = Math.round(alpha * 1000) / 1000;
    const existing = alphas.get(key);
    if (existing) return existing;
    const name = `GS${alphas.size + 1}`;
    alphas.set(key, name);
    return name;
  };

  const imageRef = (src: string): EmbeddedImage | null => {
    const data = imageData.get(src);
    if (!data) return null;
    const existing = images.get(src);
    if (existing) return existing;
    const embedded = { id: pdf.allocate(), width: data.width, height: data.height };
    images.set(src, embedded);
    return embedded;
  };

  const ops: string[] = [];

  if (options.background) {
    const bg = parseColor(options.background);
    ops.push(`${num(bg.r)} ${num(bg.g)} ${num(bg.b)} rg`);
    ops.push(`0 0 ${num(bounds.w)} ${num(bounds.h)} re f`);
  }

  // Flip into the document's y-down space, and shift so the exported rectangle
  // starts at the page origin.
  ops.push(`1 0 0 -1 0 ${num(bounds.h)} cm`);
  ops.push(`1 0 0 1 ${num(-bounds.x)} ${num(-bounds.y)} cm`);

  const setFill = (color: string) => {
    const c = parseColor(color);
    ops.push(`${num(c.r)} ${num(c.g)} ${num(c.b)} rg`);
  };
  const setStroke = (color: string, width: number) => {
    const c = parseColor(color);
    ops.push(`${num(c.r)} ${num(c.g)} ${num(c.b)} RG`);
    ops.push(`${num(width)} w`);
  };

  const emitText = (node: TextNode) => {
    const family = `Helvetica, Arial, sans-serif`;
    const layout = layoutText(measure, { ...node, fontFamily: family } as TextNode);
    const fontName = fontRef(node.fontWeight);
    const color = parseColor(node.color);

    ops.push(`${num(color.r)} ${num(color.g)} ${num(color.b)} rg`);
    ops.push("BT");
    ops.push(`/${fontName} ${num(node.fontSize)} Tf`);

    measure.font = `${node.fontWeight} ${node.fontSize}px ${family}`;
    for (let i = 0; i < layout.lines.length; i++) {
      const line = layout.lines[i]!;
      if (!line) continue;
      const width = measure.measureText(line).width;
      const x =
        node.align === "center" ? (node.w - width) / 2 : node.align === "right" ? node.w - width : 0;
      const baseline = i * layout.lineHeight + node.fontSize * BASELINE_RATIO;
      // The inner `1 0 0 -1` undoes the page flip so glyphs sit upright.
      ops.push(`1 0 0 -1 ${num(x)} ${num(baseline)} Tm`);
      ops.push(`(${pdfString(line)}) Tj`);
    }
    ops.push("ET");
  };

  const emit = (id: NodeId, inheritedOpacity: number): void => {
    const node: SceneNode | undefined = doc.nodes[id];
    if (!node || !node.visible || node.opacity <= 0.001) return;

    const opacity = inheritedOpacity * node.opacity;
    const m = localTransform(node);

    ops.push("q");
    ops.push(`${num(m.a)} ${num(m.b)} ${num(m.c)} ${num(m.d)} ${num(m.e)} ${num(m.f)} cm`);
    if (opacity < 0.999) ops.push(`/${alphaRef(opacity)} gs`);

    const stroked = "stroke" in node && node.stroke && node.strokeWidth > 0;

    switch (node.type) {
      case "frame":
      case "rect": {
        const radius = node.radius;
        if (node.fill || stroked) {
          roundedRect(ops, node.w, node.h, radius);
          if (node.fill) setFill(node.fill.color);
          if (stroked) setStroke(node.stroke!.color, node.strokeWidth);
          ops.push(node.fill && stroked ? "B" : stroked ? "S" : "f");
        }
        break;
      }
      case "ellipse": {
        if (node.fill || stroked) {
          ellipsePath(ops, node.w, node.h);
          if (node.fill) setFill(node.fill.color);
          if (stroked) setStroke(node.stroke!.color, node.strokeWidth);
          ops.push(node.fill && stroked ? "B" : stroked ? "S" : "f");
        }
        break;
      }
      case "image": {
        const embedded = node.src ? imageRef(node.src) : null;
        if (embedded) {
          ops.push("q");
          if (node.radius > 0) {
            roundedRect(ops, node.w, node.h, node.radius);
            ops.push("W n");
          }
          // PDF always draws an image into the unit square, so object-fit is
          // expressed by the placement matrix: "contain" shrinks and centres,
          // "cover" overflows and relies on the clip below.
          const box = fitBox(node.fit, embedded.width, embedded.height, node.w, node.h);
          if (node.fit === "cover" && node.radius <= 0) {
            // Cover overflows the box, so it needs a clip even without a radius.
            ops.push(`0 0 ${num(node.w)} ${num(node.h)} re`);
            ops.push("W n");
          }
          // The vertical flip undoes the page flip, so the picture is upright.
          ops.push(
            `${num(box.w)} 0 0 ${num(-box.h)} ${num(box.x)} ${num(box.y + box.h)} cm`,
          );
          ops.push(`/Im${embedded.id} Do`);
          ops.push("Q");
        } else {
          setFill("#e6e8f2");
          roundedRect(ops, node.w, node.h, node.radius);
          ops.push("f");
        }
        break;
      }
      case "text":
        emitText(node);
        break;
      case "group":
        break;
    }

    if (isContainer(node)) {
      if (node.type === "frame" && node.clip) {
        roundedRect(ops, node.w, node.h, node.radius);
        ops.push("W n");
      }
      for (const child of node.children) emit(child, opacity);
    }

    ops.push("Q");
  };

  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    // `emit` lays a node out in its *parent's* space. A selected node that is
    // not a direct child of the page therefore needs its ancestors' transform
    // established first, or it lands somewhere else entirely — usually outside
    // the MediaBox, giving a blank page.
    const parentId = node.parent;
    if (parentId && parentId !== doc.root) {
      const pw = worldTransform(doc, parentId);
      ops.push("q");

      // Re-establish any enclosing clipping frames, outermost first, so a node
      // that is half-hidden on the canvas does not export whole. These are
      // emitted in page space, leaving the transform free for `pw` below.
      const clipping = ancestorsOf(doc, id)
        .filter((n) => n.id !== doc.root && n.type === "frame" && n.clip)
        .reverse();
      for (const frame of clipping) {
        roundedRectThrough(
          ops,
          frame.w,
          frame.h,
          (frame as { radius: number }).radius,
          worldTransform(doc, frame.id),
        );
        ops.push("W n");
      }

      ops.push(`${num(pw.a)} ${num(pw.b)} ${num(pw.c)} ${num(pw.d)} ${num(pw.e)} ${num(pw.f)} cm`);
      emit(id, 1);
      ops.push("Q");
    } else {
      emit(id, 1);
    }
  }

  // --- Assemble -------------------------------------------------------------

  const content = ops.join("\n");
  pdf.add(contentId, (out) => {
    out.text(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  for (const [base, font] of fonts) {
    pdf.add(font.id, (out) => {
      out.text(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`,
      );
    });
  }

  // Local to this export: a module-level accumulator would leak ExtGState
  // references from one PDF into the next.
  const alphaObjects: { id: number; name: string; alpha: number }[] = [];
  for (const [alpha, name] of alphas) {
    const id = pdf.allocate();
    alphaObjects.push({ id, name, alpha });
    pdf.add(id, (out) => out.text(`<< /Type /ExtGState /ca ${num(alpha)} /CA ${num(alpha)} >>`));
  }

  for (const [src, embedded] of images) {
    const data = imageData.get(src)!;
    pdf.add(embedded.id, (out) => {
      out.text(
        `<< /Type /XObject /Subtype /Image /Width ${data.width} /Height ${data.height}` +
          ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode` +
          ` /Length ${data.bytes.length} >>\nstream\n`,
      );
      out.bytes(data.bytes);
      out.text("\nendstream");
    });
  }

  const fontResources = [...fonts.values()].map((f) => `/${f.name} ${f.id} 0 R`).join(" ");
  const gsResources = alphaObjects.map((g) => `/${g.name} ${g.id} 0 R`).join(" ");
  const xobjectResources = [...images.values()].map((i) => `/Im${i.id} ${i.id} 0 R`).join(" ");

  pdf.add(pageId, (out) => {
    out.text(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(bounds.w)} ${num(bounds.h)}]` +
        ` /Resources << /ProcSet [/PDF /Text /ImageC]` +
        (fontResources ? ` /Font << ${fontResources} >>` : "") +
        (gsResources ? ` /ExtGState << ${gsResources} >>` : "") +
        (xobjectResources ? ` /XObject << ${xobjectResources} >>` : "") +
        ` >> /Contents ${contentId} 0 R >>`,
    );
  });

  pdf.add(pagesId, (out) => out.text(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`));
  pdf.add(catalogId, (out) => out.text(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));
  pdf.add(infoId, (out) =>
    out.text(
      `<< /Title (${pdfString(options.title ?? "Figma-lite export")}) /Producer (figma-lite) >>`,
    ),
  );

  return pdf.finish(catalogId, infoId);
}
