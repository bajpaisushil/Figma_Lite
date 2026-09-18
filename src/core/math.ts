/**
 * 2D affine geometry.
 *
 * A matrix represents the affine map
 *
 *     | a  c  e |
 *     | b  d  f |
 *     | 0  0  1 |
 *
 * which is exactly the argument order of CanvasRenderingContext2D.setTransform,
 * so a Mat can be handed to the renderer without repacking.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const translation = (x: number, y: number): Mat => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

export const scaling = (sx: number, sy: number = sx): Mat => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });

export function rotation(radians: number): Mat {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** Returns `m ∘ n`: the map that applies `n` first, then `m`. */
export function mul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function mulAll(...mats: Mat[]): Mat {
  return mats.reduce(mul, IDENTITY);
}

/** Maps a point through the full affine transform (translation included). */
export function apply(m: Mat, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Maps a *direction* — the linear part only, so translation is ignored. */
export function applyVector(m: Mat, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y, y: m.b * p.x + m.d * p.y };
}

export function determinant(m: Mat): number {
  return m.a * m.d - m.b * m.c;
}

export function invert(m: Mat): Mat {
  const det = determinant(m);
  // A singular matrix has no inverse; degenerate (zero-area) nodes would
  // otherwise poison hit testing with NaN, so fall back to the identity.
  if (det === 0 || !Number.isFinite(det)) return IDENTITY;
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
}

/** Uniform scale factor implied by the matrix — used to keep strokes crisp. */
export function matScale(m: Mat): number {
  return Math.sqrt(Math.abs(determinant(m))) || 1;
}

/** Rotation angle of the matrix in radians. */
export function matRotation(m: Mat): number {
  return Math.atan2(m.b, m.a);
}

// --- Rectangles -------------------------------------------------------------

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export function rectFromPoints(p: Vec2, q: Vec2): Rect {
  return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(p.x - q.x), h: Math.abs(p.y - q.y) };
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function rectCorners(r: Rect): [Vec2, Vec2, Vec2, Vec2] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

export function rectContainsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return !(b.x > a.x + a.w || b.x + b.w < a.x || b.y > a.y + a.h || b.y + b.h < a.y);
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function boundsOfPoints(points: Vec2[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Axis-aligned bounding box of `r` after being mapped through `m`. */
export function transformedBounds(m: Mat, r: Rect): Rect {
  return boundsOfPoints(rectCorners(r).map((p) => apply(m, p)));
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

// --- Scalars ----------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const DEG = Math.PI / 180;

export function toDegrees(radians: number): number {
  return radians / DEG;
}

/** Normalizes an angle in radians into (-π, π]. */
export function normalizeAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let a = radians % twoPi;
  if (a <= -Math.PI) a += twoPi;
  if (a > Math.PI) a -= twoPi;
  return a;
}

/** Rounds to a sane number of decimals so JSON exports stay readable. */
export function round(v: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
