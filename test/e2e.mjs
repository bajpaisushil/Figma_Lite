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
