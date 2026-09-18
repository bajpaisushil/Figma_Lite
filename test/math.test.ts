import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY,
  apply,
  applyVector,
  boundsOfPoints,
  invert,
  matRotation,
  matScale,
  mul,
  normalizeAngle,
  rectIntersects,
  rotation,
  scaling,
  transformedBounds,
  translation,
} from "../src/core/math.ts";
import { closeTo, pointCloseTo, rectCloseTo } from "./helpers.ts";

describe("matrix algebra", () => {
  test("mul applies the right-hand matrix first", () => {
    // Translate then rotate must differ from rotate then translate.
    const t = translation(10, 0);
    const r = rotation(Math.PI / 2);
    pointCloseTo(apply(mul(r, t), { x: 0, y: 0 }), { x: 0, y: 10 }, 1e-9, "rotate∘translate");
    pointCloseTo(apply(mul(t, r), { x: 0, y: 0 }), { x: 10, y: 0 }, 1e-9, "translate∘rotate");
  });

  test("invert round-trips an arbitrary composed transform", () => {
    const m = mul(mul(translation(37, -12), rotation(0.7)), scaling(2, 3));
    const p = { x: 5, y: -9 };
    pointCloseTo(apply(invert(m), apply(m, p)), p, 1e-9);
  });

  test("invert of a singular matrix falls back to identity rather than NaN", () => {
    const degenerate = scaling(0, 0);
    assert.deepEqual(invert(degenerate), IDENTITY);
  });

  test("applyVector ignores translation", () => {
    const m = mul(translation(100, 100), rotation(Math.PI / 2));
    pointCloseTo(applyVector(m, { x: 1, y: 0 }), { x: 0, y: 1 }, 1e-9);
  });

  test("matRotation and matScale recover the composed parts", () => {
    const m = mul(mul(translation(3, 4), rotation(0.4)), scaling(2));
    closeTo(matRotation(m), 0.4, 1e-9);
    closeTo(matScale(m), 2, 1e-9);
  });
});

describe("rectangles", () => {
  test("transformedBounds gives the AABB of a rotated box", () => {
    // A 100×100 box rotated 45° about its centre spans 100√2 on both axes.
    const centre = { x: 50, y: 50 };
    const m = mul(
      mul(translation(centre.x, centre.y), rotation(Math.PI / 4)),
      translation(-centre.x, -centre.y),
    );
    const bounds = transformedBounds(m, { x: 0, y: 0, w: 100, h: 100 });
    const side = 100 * Math.SQRT2;
    rectCloseTo(bounds, { x: 50 - side / 2, y: 50 - side / 2, w: side, h: side }, 1e-9);
  });

  test("rectIntersects is exclusive at a shared edge only when disjoint", () => {
    assert.ok(rectIntersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }));
    assert.ok(!rectIntersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 0, w: 10, h: 10 }));
  });

  test("boundsOfPoints handles the empty case without NaN", () => {
    assert.deepEqual(boundsOfPoints([]), { x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("angles", () => {
  test("normalizeAngle maps into (-pi, pi]", () => {
    closeTo(normalizeAngle(3 * Math.PI), Math.PI, 1e-9);
    closeTo(normalizeAngle(-3 * Math.PI), Math.PI, 1e-9);
    closeTo(normalizeAngle(Math.PI / 2), Math.PI / 2, 1e-9);
    closeTo(normalizeAngle(2 * Math.PI + 0.3), 0.3, 1e-9);
  });
});
