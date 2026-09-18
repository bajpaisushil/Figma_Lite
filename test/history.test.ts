import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { History, applySide, diffDocuments } from "../src/core/history.ts";
import { Editor } from "../src/core/editor.ts";
import { deleteNodes, insertNode, translateNodes, updateNodes } from "../src/core/commands.ts";
import { createNode } from "../src/core/factory.ts";
import { build, childIds } from "./helpers.ts";

describe("diffing", () => {
  test("returns null when nothing changed", () => {
    const doc = build([{ id: "a" }]);
    assert.equal(diffDocuments(doc, doc), null);
    assert.equal(diffDocuments(doc, updateNodes(doc, { missing: { x: 1 } })), null);
  });

  test("records only the nodes whose identity changed", () => {
    const doc = build([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const next = updateNodes(doc, { b: { x: 5 } });
    const delta = diffDocuments(doc, next)!;

    assert.deepEqual(Object.keys(delta.before), ["b"]);
    assert.equal(delta.before.b, doc.nodes.b);
    assert.equal(delta.after.b, next.nodes.b);
  });

  test("represents insertion and deletion with a null on one side", () => {
    const doc = build([{ id: "f", type: "frame", children: [{ id: "a" }] }]);
    const removed = deleteNodes(doc, ["a"]);
    const delta = diffDocuments(doc, removed)!;

    assert.equal(delta.after.a, null, "deleted node is null on the after side");
    assert.ok(delta.before.a, "and present on the before side");
    assert.ok(delta.before.f && delta.after.f, "the parent changed too");
  });

  test("applySide is an exact inverse of the edit", () => {
    const doc = build([{ id: "a", x: 0 }]);
    const next = updateNodes(doc, { a: { x: 42 } });
    const delta = diffDocuments(doc, next)!;

    assert.equal(applySide(next, delta.before).nodes.a!.x, 0);
    assert.equal(applySide(doc, delta.after).nodes.a!.x, 42);
  });
});

describe("History", () => {
  const start = build([{ id: "a", x: 0 }]);

  test("undo and redo round-trip a single edit", () => {
    const history = new History();
    const moved = translateNodes(start, ["a"], 10, 0);

    assert.ok(history.record("Move", { doc: start, selection: [] }, { doc: moved, selection: ["a"] }));
    assert.equal(history.canUndo, true);

    const undone = history.undo({ doc: moved, selection: ["a"] })!;
    assert.equal(undone.doc.nodes.a!.x, 0);
    assert.deepEqual(undone.selection, []);

    const redone = history.redo(undone)!;
    assert.equal(redone.doc.nodes.a!.x, 10);
    assert.deepEqual(redone.selection, ["a"]);
  });

  test("recording a no-op change is rejected", () => {
    const history = new History();
    assert.equal(history.record("Nothing", { doc: start, selection: [] }, { doc: start, selection: [] }), false);
    assert.equal(history.canUndo, false);
  });

  test("a selection-only change is not worth a history entry", () => {
    const history = new History();
    assert.equal(history.record("Select", { doc: start, selection: [] }, { doc: start, selection: ["a"] }), false);
    assert.equal(history.depth, 0);
  });

  test("a new edit clears the redo stack", () => {
    const history = new History();
    const one = translateNodes(start, ["a"], 10, 0);
    history.record("Move", { doc: start, selection: [] }, { doc: one, selection: [] });
    history.undo({ doc: one, selection: [] });
    assert.equal(history.canRedo, true);

    const two = translateNodes(start, ["a"], 0, 5);
    history.record("Move", { doc: start, selection: [] }, { doc: two, selection: [] });
    assert.equal(history.canRedo, false);
  });

  test("same-key edits inside the window merge into one entry", () => {
    const history = new History();
    const one = translateNodes(start, ["a"], 1, 0);
    const two = translateNodes(one, ["a"], 1, 0);

    history.record("Nudge", { doc: start, selection: [] }, { doc: one, selection: [] }, "nudge");
    history.record("Nudge", { doc: one, selection: [] }, { doc: two, selection: [] }, "nudge");
    assert.equal(history.depth, 1, "the two nudges collapsed");

    // Undoing once must return all the way to the original position.
    const undone = history.undo({ doc: two, selection: [] })!;
    assert.equal(undone.doc.nodes.a!.x, 0);
  });

  test("edits without a merge key never merge", () => {
    const history = new History();
    const one = translateNodes(start, ["a"], 1, 0);
    const two = translateNodes(one, ["a"], 1, 0);
    history.record("Move", { doc: start, selection: [] }, { doc: one, selection: [] });
    history.record("Move", { doc: one, selection: [] }, { doc: two, selection: [] });
    assert.equal(history.depth, 2);
  });

  test("the stack is bounded", () => {
    const history = new History({ limit: 3 });
    let doc = start;
    for (let i = 0; i < 6; i++) {
      const next = translateNodes(doc, ["a"], 1, 0);
      history.record(`Move ${i}`, { doc, selection: [] }, { doc: next, selection: [] });
      doc = next;
    }
    assert.equal(history.depth, 3);
  });

  test("undo on an empty stack returns null", () => {
    assert.equal(new History().undo({ doc: start, selection: [] }), null);
  });
});

describe("Editor gestures", () => {
  function editorWith() {
    const editor = new Editor();
    editor.load(build([{ id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 0 }]));
    return editor;
  }

  test("commit records exactly one entry", () => {
    const editor = editorWith();
    editor.commit("Move", (doc) => translateNodes(doc, ["a"], 10, 0));
    assert.equal(editor.history.depth, 1);
    assert.equal(editor.doc.nodes.a!.x, 10);
  });

  test("a gesture of many live steps collapses into one undo", () => {
    const editor = editorWith();
    const startDoc = editor.doc;

    editor.begin("Move");
    for (let i = 1; i <= 50; i++) {
      editor.live(() => translateNodes(startDoc, ["a"], i, 0));
    }
    editor.end();

    assert.equal(editor.history.depth, 1, "50 frames, one history entry");
    assert.equal(editor.doc.nodes.a!.x, 50);

    editor.undo();
    assert.equal(editor.doc.nodes.a!.x, 0, "undo returns to before the gesture");
  });

  test("cancel restores the document captured at begin", () => {
    const editor = editorWith();
    const startDoc = editor.doc;

    editor.begin("Move");
    editor.live(() => translateNodes(startDoc, ["a"], 99, 99));
    editor.cancel();

    assert.equal(editor.doc.nodes.a!.x, 0);
    assert.equal(editor.history.depth, 0, "a cancelled gesture leaves no trace");
  });

  test("undo restores the selection that was live at the time", () => {
    const editor = editorWith();
    editor.setSelection(["a"]);
    editor.commit("Delete", (doc) => deleteNodes(doc, ["a"]));

    assert.deepEqual(editor.selection, [], "selection is pruned to existing nodes");
    editor.undo();
    assert.ok(editor.doc.nodes.a, "the node is back");
    assert.deepEqual(editor.selection, ["a"], "and so is the selection");
  });

  test("undo and redo survive an insert/delete pair", () => {
    const editor = editorWith();
    const node = createNode("ellipse", { id: "new", name: "new", box: { x: 5, y: 5, w: 10, h: 10 } });

    editor.commit("Insert", (doc) => insertNode(doc, node));
    assert.ok(editor.doc.nodes.new);

    editor.undo();
    assert.equal(editor.doc.nodes.new, undefined);
    const rootChildren = () => childIds(editor.doc, editor.doc.root);
    assert.ok(!rootChildren().includes("new"), "the parent link is undone too");

    editor.redo();
    assert.ok(editor.doc.nodes.new);
    assert.ok(rootChildren().includes("new"));
  });

  test("load clears history so you cannot undo into the previous file", () => {
    const editor = editorWith();
    editor.commit("Move", (doc) => translateNodes(doc, ["a"], 10, 0));
    editor.load(build([{ id: "z" }]));
    assert.equal(editor.history.canUndo, false);
  });

  test("selection never contains ids that are gone", () => {
    const editor = editorWith();
    editor.setSelection(["a", "b", "ghost"]);
    assert.deepEqual(editor.selection, ["a", "b"]);
  });
});
