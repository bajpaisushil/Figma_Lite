/**
 * A byte assembler for binary file formats.
 *
 * PDF mixes ASCII structure with raw binary streams, so the file cannot be
 * built as a string. This collects both and tracks the running offset, which is
 * what the cross-reference table needs.
 */
export class ByteBuilder {
  private chunks: Uint8Array[] = [];
  private length = 0;

  /** Appends text as Latin-1, the encoding PDF structure is written in. */
  text(value: string): this {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
    return this.bytes(bytes);
  }

  bytes(value: Uint8Array): this {
    this.chunks.push(value);
    this.length += value.length;
    return this;
  }

  /** Byte offset of the next write — an object's position in the xref table. */
  get offset(): number {
    return this.length;
  }

  // Typed against a plain ArrayBuffer (not ArrayBufferLike) so the result is
  // directly usable as a BlobPart.
  toUint8Array(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(this.length));
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  toBlob(type: string): Blob {
    return new Blob([this.toUint8Array()], { type });
  }
}

/** Decodes the payload of a `data:` URL into bytes. */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const [, mime, isBase64, payload] = match;

  if (!isBase64) {
    const decoded = decodeURIComponent(payload!);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 0xff;
    return { bytes, mime: mime! };
  }

  const binary = atob(payload!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime: mime! };
}
