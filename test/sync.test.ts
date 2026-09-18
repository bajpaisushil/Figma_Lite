import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { LibrarySync, type SyncMessage } from "../src/core/sync.ts";

/**
 * Node has BroadcastChannel natively, so two instances really do talk. The
 * handle is ref'd though, and would hold the test process open forever, so
 * every channel is unref'd and tracked for cleanup.
 */
const open: BroadcastChannel[] = [];
const channelFor = (name: string) => {
  const channel = new BroadcastChannel(name);
  (channel as unknown as { unref?: () => void }).unref?.();
  open.push(channel as unknown as BroadcastChannel);
  return channel as unknown as BroadcastChannel;
};

after(() => {
  for (const channel of open) {
    try {
      channel.close();
    } catch {
      // Already closed by the test.
    }
  }
});

function waitFor<T>(fn: (resolve: (value: T) => void) => void, ms = 1000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    fn((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe("LibrarySync", () => {
  test("one tab hears another tab's message", async () => {
    const name = `test-${Math.random()}`;
    const received = waitFor<SyncMessage>((resolve) => {
      const listener = new LibrarySync((m) => resolve(m), { channelName: name, factory: channelFor });
      assert.ok(listener.isActive);
      const sender = new LibrarySync(() => undefined, { channelName: name, factory: channelFor });
      setTimeout(() => sender.post("saved", "doc-1"), 10);
      // Closed by the `after` hook above.
    });

    const message = await received;
    assert.equal(message.kind, "saved");
    assert.equal(message.docId, "doc-1");
    assert.ok(message.tabId);
  });

  test("a tab never acts on its own broadcast", async () => {
    const name = `test-${Math.random()}`;
    let selfHeard = 0;
    const solo = new LibrarySync(() => selfHeard++, { channelName: name, factory: channelFor });
    solo.post("library");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(selfHeard, 0);
    solo.close();
  });

  test("tab ids are unique", () => {
    const a = new LibrarySync(() => undefined, { factory: null });
    const b = new LibrarySync(() => undefined, { factory: null });
    assert.notEqual(a.tabId, b.tabId);
  });

  test("degrades to a no-op where BroadcastChannel is unavailable", () => {
    const sync = new LibrarySync(() => undefined, { factory: null });
    assert.equal(sync.isActive, false);
    // Must not throw.
    sync.post("saved", "doc-1");
    sync.close();
  });

  test("posting after close is harmless", () => {
    const sync = new LibrarySync(() => undefined, { channelName: `t-${Math.random()}`, factory: channelFor });
    sync.close();
    sync.post("library");
    assert.equal(sync.isActive, false);
  });
});
