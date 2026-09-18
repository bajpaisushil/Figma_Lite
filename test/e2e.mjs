/**
 * End-to-end smoke test.
 *
 * The unit suite covers the model, but ~400 lines of DOM wiring in main.ts can
 * only really be checked by booting the thing. This drives a real browser
 * against the production build and asserts the app boots clean, paints pixels,
 * and that a draw / undo / redo round trip works through actual input events.
 */

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const PORT = 4173;
const URL = `http://127.0.0.1:${PORT}/`;

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not start at ${url}`);
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push([true, name]);
      console.log(`  ok   ${name}`);
    })
    .catch((error) => {
      results.push([false, name]);
      console.log(`  FAIL ${name}\n       ${error.message}`);
    });
}

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--host", "127.0.0.1"], {
  cwd: process.cwd(),
  stdio: "ignore",
});

let browser;
try {
  await waitForServer(URL);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const ready = () => page.waitForFunction(() => Boolean(window.editor), null, { timeout: 15000 });

  await page.goto(URL, { waitUntil: "networkidle" });
  await ready();
  // Start from a clean slate: both the IndexedDB stores and the legacy key.
  await page.evaluate(async () => {
    localStorage.clear();
    await window.debug.clearStorage();
  });
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  await page.waitForTimeout(300);

  console.log("\nboot");
  await check("no console or page errors on load", () => {
    assert.deepEqual(consoleErrors, []);
  });

  await check("chrome is present: toolbar, layers, inspector, canvas", async () => {
    for (const selector of [".toolbar", ".panel-left", ".panel-right", ".scene-canvas", ".overlay-canvas"]) {
      assert.ok(await page.locator(selector).count(), `missing ${selector}`);
    }
  });

  await check("the document is stored in IndexedDB, not localStorage", async () => {
    assert.equal(await page.evaluate(() => window.debug.storageKind()), "indexeddb");
  });

  await check("the sample document populated the layers panel", async () => {
    const rows = await page.locator(".layer-row").count();
    assert.ok(rows >= 5, `expected the sample layers, saw ${rows}`);
  });

  await check("the scene canvas actually painted pixels", async () => {
    const painted = await page.evaluate(() => {
      const canvas = document.querySelector(".scene-canvas");
      const ctx = canvas.getContext("2d");
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
      return opaque;
    });
    assert.ok(painted > 10000, `only ${painted} non-transparent pixels`);
  });

  console.log("\nselection");
  const canvas = page.locator(".overlay-canvas");
  const box = await canvas.boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  await check("clicking a shape selects it and fills the inspector", async () => {
    const p = at(0.3, 0.45);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);

    const selection = await page.evaluate(() => window.editor.selection.length);
    assert.equal(selection, 1, "expected exactly one selected node");
    assert.ok(await page.locator(".panel-right .field-grid").count(), "inspector shows layout fields");
  });

  await check("Escape clears the selection", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.editor.selection.length), 0);
  });

  console.log("\ndraw, undo, redo");
  await check("pressing R and dragging creates a rectangle", async () => {
    const before = await page.evaluate(() => Object.keys(window.editor.doc.nodes).length);

    await page.keyboard.press("r");
    const start = at(0.62, 0.72);
    const end = at(0.78, 0.88);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const after = await page.evaluate(() => Object.keys(window.editor.doc.nodes).length);
    assert.equal(after, before + 1, "one new node");

    const node = await page.evaluate(() => {
      const id = window.editor.selection[0];
      const n = window.editor.doc.nodes[id];
      return { type: n.type, w: Math.round(n.w), h: Math.round(n.h) };
    });
    assert.equal(node.type, "rect");
    assert.ok(node.w > 40 && node.h > 40, `drew a ${node.w}x${node.h} rect`);
  });

  await check("the drag produced exactly one undo entry", async () => {
    assert.equal(await page.evaluate(() => window.editor.history.depth), 1);
  });

  await check("undo removes it and redo brings it back", async () => {
    const count = () => page.evaluate(() => Object.keys(window.editor.doc.nodes).length);
    const withRect = await count();

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(200);
    assert.equal(await count(), withRect - 1, "undo removed the rectangle");

    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(200);
    assert.equal(await count(), withRect, "redo restored it");
  });

  console.log("\nmove and snap");
  await check("dragging a shape moves it and records one entry", async () => {
    const depthBefore = await page.evaluate(() => window.editor.history.depth);
    const p = at(0.3, 0.45);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(150);

    const before = await page.evaluate(() => {
      const n = window.editor.doc.nodes[window.editor.selection[0]];
      return { x: n.x, y: n.y };
    });

    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 90, p.y + 40, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const after = await page.evaluate(() => {
      const n = window.editor.doc.nodes[window.editor.selection[0]];
      return { x: n.x, y: n.y };
    });
    assert.ok(Math.abs(after.x - before.x) > 20, `moved in x (${before.x} → ${after.x})`);
    assert.equal(
      await page.evaluate(() => window.editor.history.depth),
      depthBefore + 1,
      "a whole drag is one undo entry",
    );
  });

  console.log("\nzoom, pan, export");
  await check("Ctrl+scroll zooms about the pointer", async () => {
    const zoomBefore = await page.evaluate(() => window.editor.viewport.zoom);
    const p = at(0.5, 0.5);
    await page.mouse.move(p.x, p.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -240);
    await page.keyboard.up("Control");
    await page.waitForTimeout(200);

    const zoomAfter = await page.evaluate(() => window.editor.viewport.zoom);
    assert.ok(zoomAfter > zoomBefore, `zoom ${zoomBefore} → ${zoomAfter}`);
  });

  await check("the document exports to JSON that re-imports cleanly", async () => {
    const json = await page.evaluate(() => window.debug.toJSON());
    const parsed = JSON.parse(json);
    assert.equal(parsed.generator, "figma-lite");
    assert.ok(Object.keys(parsed.nodes).length > 5);
  });

  await check("the shortcut sheet opens", async () => {
    await page.locator('button[aria-label="Keyboard shortcuts"]').click();
    await page.waitForTimeout(300);
    assert.ok(await page.locator(".modal .help-row").count(), "shortcut rows rendered");
    await page.keyboard.press("Escape");
  });

  await check("still no console errors after all interaction", () => {
    assert.deepEqual(consoleErrors, []);
  });

  console.log("\nmanipulation");

  // Picks a top-level unrotated node and returns its id plus the screen
  // position of a chosen corner, so handle drags can be aimed precisely.
  const pickNode = async () => {
    const picked = await page.evaluate(() => {
      // Earlier checks pan and zoom, which can push handles off-canvas. Reset
      // the view first so the drag targets below are actually reachable.
      window.editor.zoomToFit();
      const doc = window.editor.doc;
      const candidates = doc.nodes[doc.root].children
        .map((c) => doc.nodes[c])
        .filter((n) => n && n.rotation === 0 && n.w > 40 && n.h > 40);
      const n = candidates.sort((a, b) => b.w * b.h - a.w * a.h)[0];
      window.editor.setSelection([n.id]);
      return {
        id: n.id,
        w: n.w,
        h: n.h,
        se: window.editor.toScreen({ x: n.x + n.w, y: n.y + n.h }),
        ne: window.editor.toScreen({ x: n.x + n.w, y: n.y }),
        viewport: { w: window.editor.viewport.width, h: window.editor.viewport.height },
      };
    });

    // Fail loudly rather than silently dragging empty space, which is exactly
    // how the first version of this test passed while doing nothing.
    const inside = (p) =>
      p.x > 4 && p.y > 4 && p.x < picked.viewport.w - 4 && p.y < picked.viewport.h - 4;
    assert.ok(inside(picked.se), `SE handle is on canvas: ${JSON.stringify(picked.se)}`);
    assert.ok(inside(picked.ne), `NE handle is on canvas: ${JSON.stringify(picked.ne)}`);
    await page.waitForTimeout(150);
    return picked;
  };

  await check("dragging a corner handle resizes, in one undo step", async () => {
    const before = await pickNode();
    const depth = await page.evaluate(() => window.editor.history.depth);

    await page.mouse.move(box.x + before.se.x, box.y + before.se.y);
    await page.mouse.down();
    await page.mouse.move(box.x + before.se.x + 70, box.y + before.se.y + 50, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const after = await page.evaluate((id) => {
      const n = window.editor.doc.nodes[id];
      return { w: n.w, h: n.h, x: n.x, y: n.y };
    }, before.id);

    assert.ok(after.w > before.w + 30, `width grew (${before.w} -> ${after.w})`);
    assert.ok(after.h > before.h + 20, `height grew (${before.h} -> ${after.h})`);
    assert.equal(
      await page.evaluate(() => window.editor.history.depth),
      depth + 1,
      "the whole resize is one undo entry",
    );
  });

  await check("resize pins the opposite corner", async () => {
    const before = await pickNode();
    const origin = await page.evaluate((id) => {
      const n = window.editor.doc.nodes[id];
      return { x: n.x, y: n.y };
    }, before.id);

    await page.mouse.move(box.x + before.se.x, box.y + before.se.y);
    await page.mouse.down();
    await page.mouse.move(box.x + before.se.x + 60, box.y + before.se.y + 40, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const after = await page.evaluate((id) => {
      const n = window.editor.doc.nodes[id];
      return { x: n.x, y: n.y, w: n.w };
    }, before.id);
    assert.ok(after.w > before.w + 20, `the drag actually resized (${before.w} -> ${after.w})`);
    assert.ok(Math.abs(after.x - origin.x) < 0.5, `top-left x held (${origin.x} -> ${after.x})`);
    assert.ok(Math.abs(after.y - origin.y) < 0.5, `top-left y held (${origin.y} -> ${after.y})`);
  });

  await check("dragging outside a corner rotates", async () => {
    const before = await pickNode();

    // The rotation hot-zone sits just beyond the corner handle.
    const start = { x: box.x + before.ne.x + 14, y: box.y + before.ne.y - 14 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 60, start.y + 90, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const rotation = await page.evaluate((id) => window.editor.doc.nodes[id].rotation, before.id);
    assert.ok(Math.abs(rotation) > 0.05, `rotation changed (${rotation} rad)`);
  });

  await check("grouping reparents the selection and ungrouping restores it", async () => {
    const ids = await page.evaluate(() => {
      const doc = window.editor.doc;
      const picked = doc.nodes[doc.root].children.slice(0, 2);
      window.editor.setSelection(picked);
      return picked;
    });
    await page.waitForTimeout(150);

    await page.keyboard.press("Control+g");
    await page.waitForTimeout(250);

    const grouped = await page.evaluate((ids) => {
      const doc = window.editor.doc;
      const parents = ids.map((id) => doc.nodes[id].parent);
      return { parents, selection: window.editor.selection, type: doc.nodes[window.editor.selection[0]]?.type };
    }, ids);

    assert.equal(grouped.type, "group", "a group is selected");
    assert.equal(grouped.parents[0], grouped.selection[0], "both members were reparented");
    assert.equal(grouped.parents[1], grouped.selection[0]);

    await page.keyboard.press("Control+Shift+g");
    await page.waitForTimeout(250);
    const after = await page.evaluate(
      (ids) => ids.map((id) => window.editor.doc.nodes[id].parent),
      ids,
    );
    assert.deepEqual(after, ["root", "root"], "ungrouping returned them to the page");
  });

  await check("the align buttons line the selection up", async () => {
    await page.evaluate(() => {
      const doc = window.editor.doc;
      window.editor.setSelection(doc.nodes[doc.root].children.slice(0, 2));
    });
    await page.waitForTimeout(200);

    await page.locator('button[aria-label="Align left"]').click();
    await page.waitForTimeout(250);

    const lefts = await page.evaluate(() =>
      window.editor.selection.map((id) => {
        const b = window.debug.deepWorldBounds(window.editor.doc, id);
        return Math.round(b.x);
      }),
    );
    assert.equal(new Set(lefts).size, 1, `left edges agree: ${lefts.join(", ")}`);
  });

  await check("copy and paste adds a detached duplicate", async () => {
    const before = await page.evaluate(() => {
      const doc = window.editor.doc;
      window.editor.setSelection([doc.nodes[doc.root].children[0]]);
      return Object.keys(doc.nodes).length;
    });
    await page.waitForTimeout(150);

    await page.keyboard.press("Control+c");
    await page.waitForTimeout(250);
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(400);

    const after = await page.evaluate(() => ({
      count: Object.keys(window.editor.doc.nodes).length,
      selection: window.editor.selection.length,
    }));
    assert.ok(after.count > before, `node count grew (${before} -> ${after.count})`);
    assert.ok(after.selection > 0, "the pasted copy is selected");
  });

  await check("undo unwinds the whole session cleanly", async () => {
    // Every gesture above should be individually undoable without error.
    const depth = await page.evaluate(() => window.editor.history.depth);
    assert.ok(depth >= 5, `expected several undo entries, saw ${depth}`);

    for (let i = 0; i < depth; i++) await page.keyboard.press("Control+z");
    await page.waitForTimeout(500);

    assert.equal(await page.evaluate(() => window.editor.history.canUndo), false, "stack emptied");
    assert.deepEqual(consoleErrors, [], "no errors while unwinding");
  });

  console.log("\nexport");

  // Runs an export in the page and returns the first bytes plus the size, so
  // the file format can be checked rather than just "a blob appeared".
  const exportProbe = (format, opts = {}) =>
    page.evaluate(
      async ({ format, opts }) => {
        const mod = window.debug.exportApi;
        const result = await mod.runExport(window.editor.doc, window.editor.selection, {
          format,
          selectionOnly: false,
          scale: 1,
          documentName: "probe",
          ...opts,
        });
        const buffer = new Uint8Array(await result.blob.arrayBuffer());
        const head = String.fromCharCode(...buffer.slice(0, 8));
        const tail = String.fromCharCode(...buffer.slice(-8));
        const text = new TextDecoder("latin1").decode(buffer);
        return { size: buffer.length, head, tail, text, filename: result.filename };
      },
      { format, opts },
    );

  await check("PNG export produces a real PNG", async () => {
    const png = await exportProbe("png", { scale: 2 });
    assert.ok(png.size > 1000, `non-trivial file (${png.size} bytes)`);
    // \x89PNG\r\n\x1a\n
    assert.equal(png.head.charCodeAt(0), 0x89);
    assert.equal(png.head.slice(1, 4), "PNG");
    assert.ok(png.filename.endsWith(".png"), png.filename);
  });

  await check("JPG export produces a real JPEG", async () => {
    const jpg = await exportProbe("jpeg");
    assert.equal(jpg.head.charCodeAt(0), 0xff);
    assert.equal(jpg.head.charCodeAt(1), 0xd8, "SOI marker");
    assert.ok(jpg.filename.endsWith(".jpg"), jpg.filename);
  });

  await check("PDF export is a structurally valid vector PDF", async () => {
    const pdf = await exportProbe("pdf");
    assert.ok(pdf.head.startsWith("%PDF-"), `header: ${JSON.stringify(pdf.head)}`);
    assert.ok(pdf.tail.includes("%%EOF"), `trailer: ${JSON.stringify(pdf.tail)}`);

    for (const marker of ["/Type /Catalog", "/Type /Pages", "/Type /Page", "xref", "trailer", "startxref"]) {
      assert.ok(pdf.text.includes(marker), `missing ${marker}`);
    }
    // Vector, not a wrapped bitmap: real path and text operators must appear.
    assert.ok(/\bre\b/.test(pdf.text) || /\bc\b/.test(pdf.text), "path operators present");
    assert.ok(pdf.text.includes("BT") && pdf.text.includes("Tj"), "text drawn as text");
    assert.ok(pdf.text.includes("/BaseFont /Helvetica"), "a standard font is referenced");
    assert.ok(pdf.size < 200_000, `vector output stays small (${pdf.size} bytes)`);
  });

  await check("the PDF cross-reference offsets point at real objects", async () => {
    const pdf = await exportProbe("pdf");
    // Every xref entry must land on "<n> 0 obj" — the check a reader performs.
    // Match the table's own header, not the "xref" inside the later "startxref".
    const xrefAt = pdf.text.lastIndexOf("\nxref\n");
    assert.ok(xrefAt > 0, "the cross-reference table exists");
    const table = pdf.text.slice(xrefAt);
    const entries = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.ok(entries.length >= 4, `found ${entries.length} objects`);
    for (const [index, offset] of entries.entries()) {
      const at = pdf.text.slice(offset, offset + 20);
      assert.ok(/^\d+ 0 obj/.test(at), `object ${index + 1} at ${offset}: ${JSON.stringify(at)}`);
    }
  });

  await check("the requested export scale reaches the pixels", async () => {
    // The renderer sizes its backing store by device pixel ratio; export has to
    // override that or 2x silently produces a 1x image.
    const dims = await page.evaluate(async () => {
      const api = window.debug.exportApi;
      const measure = async (scale) => {
        const r = await api.runExport(window.editor.doc, [], {
          format: "png",
          selectionOnly: false,
          scale,
          documentName: "scale",
        });
        const bitmap = await createImageBitmap(r.blob);
        const size = { w: bitmap.width, h: bitmap.height };
        bitmap.close();
        return size;
      };
      return { one: await measure(1), two: await measure(2) };
    });

    assert.ok(Math.abs(dims.two.w - dims.one.w * 2) <= 2, `2x width (${dims.one.w} -> ${dims.two.w})`);
    assert.ok(Math.abs(dims.two.h - dims.one.h * 2) <= 2, `2x height (${dims.one.h} -> ${dims.two.h})`);
  });

  await check("JPEG export has a white background, not a black one", async () => {
    // JPEG has no alpha, so a transparent canvas encodes as black. The
    // background must be composited under the artwork after render() clears.
    const corner = await page.evaluate(async () => {
      const api = window.debug.exportApi;
      const r = await api.runExport(window.editor.doc, [], {
        format: "jpeg",
        selectionOnly: false,
        scale: 1,
        documentName: "bg",
      });
      const bitmap = await createImageBitmap(r.blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      // The very corner is padding, so it is pure background.
      const [r0, g0, b0] = ctx.getImageData(1, 1, 1, 1).data;
      return { r: r0, g: g0, b: b0 };
    });
    assert.ok(
      corner.r > 200 && corner.g > 200 && corner.b > 200,
      `corner is light, got rgb(${corner.r}, ${corner.g}, ${corner.b})`,
    );
  });

  await check("a nested selection exports to a PDF that is not blank", async () => {
    // emit() lays a node out in its parent's space, so a node inside a frame
    // needs its ancestors' transform established or it falls outside the page.
    const result = await page.evaluate(async () => {
      const doc = window.editor.doc;
      // Find any node whose parent is not the page itself.
      const nested = Object.values(doc.nodes).find(
        (n) => n.parent && n.parent !== doc.root && n.type !== "group",
      );
      if (!nested) return { skipped: true };
      window.editor.setSelection([nested.id]);

      const api = window.debug.exportApi;
      const r = await api.runExport(doc, [nested.id], {
        format: "pdf",
        selectionOnly: true,
        scale: 1,
        documentName: "nested",
      });
      const text = new TextDecoder("latin1").decode(new Uint8Array(await r.blob.arrayBuffer()));
      const stream = text.slice(text.indexOf("stream"), text.indexOf("endstream"));
      const box = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text);
      return {
        skipped: false,
        drawOps: (stream.match(/\b(re|c|Do|Tj)\b/g) || []).length,
        page: box ? { w: Number(box[1]), h: Number(box[2]) } : null,
        stream,
      };
    });

    if (result.skipped) return;
    assert.ok(result.page && result.page.w > 1 && result.page.h > 1, "the page has real dimensions");
    assert.ok(result.drawOps > 0, `the content stream draws something (${result.drawOps} ops)`);

    // Every coordinate the stream paints at should be within reach of the page,
    // which is what the missing ancestor transform broke.
    const numbers = (result.stream.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const wild = numbers.filter((n) => Math.abs(n) > Math.max(result.page.w, result.page.h) * 6);
    assert.equal(wild.length, 0, `no runaway coordinates (saw ${wild.slice(0, 4).join(", ")})`);
    await page.keyboard.press("Escape");
  });

  await check("selection-only export crops to the selection", async () => {
    await page.evaluate(() => {
      const first = window.editor.doc.nodes[window.editor.doc.root].children[0];
      window.editor.setSelection([first]);
    });
    await page.waitForTimeout(150);

    const sizes = await page.evaluate(async () => {
      const api = window.debug.exportApi;
      const all = api.resolveTarget(window.editor.doc, window.editor.selection, false);
      const one = api.resolveTarget(window.editor.doc, window.editor.selection, true);
      return { all: all.bounds.w * all.bounds.h, one: one.bounds.w * one.bounds.h };
    });
    assert.ok(sizes.one < sizes.all, `selection area ${sizes.one} < page area ${sizes.all}`);
    await page.keyboard.press("Escape");
  });

  console.log("\npersistence");
  await check("edits survive a page refresh via autosave", async () => {
    // Draw something recognisable, wait past the autosave debounce, reload.
    await page.keyboard.press("o");
    const a = at(0.2, 0.8);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 120, a.y + 90, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const before = await page.evaluate(() => ({
      count: Object.keys(window.editor.doc.nodes).length,
      ellipses: Object.values(window.editor.doc.nodes).filter((n) => n.type === "ellipse").length,
    }));

    await page.reload({ waitUntil: "networkidle" });
    await ready();
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => ({
      count: Object.keys(window.editor.doc.nodes).length,
      ellipses: Object.values(window.editor.doc.nodes).filter((n) => n.type === "ellipse").length,
      historyDepth: window.editor.history.depth,
    }));

    assert.equal(after.count, before.count, "every node came back");
    assert.equal(after.ellipses, before.ellipses, "including the new ellipse");
    assert.equal(after.historyDepth, 0, "history deliberately does not persist");
  });

  await check("a document larger than the old 5MB cap survives a refresh", async () => {
    // The exact case that broke on localStorage: an inlined image. 6MB of
    // base64 exceeds the old origin quota on its own.
    await page.evaluate(() => {
      const big = `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`;
      const { insertNode } = window.debug.commands;
      window.editor.commit("Insert big image", (doc) =>
        insertNode(doc, {
          id: "bigimage",
          type: "image",
          name: "Big",
          parent: null,
          x: 0, y: 0, w: 100, h: 100,
          rotation: 0, opacity: 1, visible: true, locked: false,
          src: big, radius: 0, fit: "cover", strokeWidth: 0,
        }),
      );
    });
    await page.waitForTimeout(2000);

    await page.reload({ waitUntil: "networkidle" });
    await ready();
    await page.waitForTimeout(500);

    const src = await page.evaluate(() => window.editor.doc.nodes.bigimage?.src?.length ?? 0);
    assert.ok(src > 6_000_000, `the 6MB image came back (got ${src} chars)`);
  });

  await check("no quota warning was shown for that document", async () => {
    const warned = await page.locator(".toast-warn").count();
    assert.equal(warned, 0, "IndexedDB absorbed it without complaint");
  });

  await check("clearing storage falls back to the sample document", async () => {
    await page.evaluate(async () => {
      localStorage.clear();
      await window.debug.clearStorage();
    });
    await page.reload({ waitUntil: "networkidle" });
    await ready();
    await page.waitForTimeout(400);
    const count = await page.evaluate(() => Object.keys(window.editor.doc.nodes).length);
    assert.equal(count, 15, "the starter scene is back");
  });

  console.log("\nresponsive");
  await check("narrow viewport keeps the canvas usable", async () => {
    await page.setViewportSize({ width: 420, height: 780 });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px`);
    assert.ok(await page.locator(".canvas-host").isVisible());
  });
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`failing: ${failed.map(([, name]) => name).join(", ")}`);
  process.exit(1);
}
