/**
 * Image cache.
 *
 * The renderer is synchronous, so it can only ever draw an image that has
 * already decoded. This cache hands back a decoded bitmap or nothing, and
 * fires a callback once a pending load lands so the frame can be redrawn.
 */

export class ImageCache {
  private cache = new Map<string, HTMLImageElement>();
  private pending = new Set<string>();
  private failed = new Set<string>();

  constructor(private readonly onLoad: () => void) {}

  /** Returns the decoded image, or null while it loads (or if it failed). */
  get(src: string): HTMLImageElement | null {
    if (!src) return null;
    const hit = this.cache.get(src);
    if (hit) return hit;
    if (this.pending.has(src) || this.failed.has(src)) return null;

    this.pending.add(src);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      this.pending.delete(src);
      this.cache.set(src, img);
      this.onLoad();
    };
    img.onerror = () => {
      this.pending.delete(src);
      this.failed.add(src);
      this.onLoad();
    };
    img.src = src;
    return null;
  }

  has(src: string): boolean {
    return this.cache.has(src);
  }
}
