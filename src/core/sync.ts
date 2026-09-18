/**
 * Cross-tab coordination.
 *
 * Two tabs on the same origin share one IndexedDB, so without a word between
 * them the second tab's autosave silently overwrites the first's. The storage
 * layer already refuses to write a *corrupt* document (see `write` re-reading
 * the summary), but last-write-wins is still surprising if nobody says so.
 *
 * This is deliberately a notification channel, not a merge protocol. Operational
 * transforms for a local-first design tool is a different project; telling the
 * user their document changed elsewhere is the honest minimum.
 *
 * `BroadcastChannel` is absent in a few environments, so every method degrades
 * to a no-op rather than throwing.
 */

export type SyncKind = "saved" | "deleted" | "library";

export interface SyncMessage {
  /** Identifies the sender, so a tab ignores its own broadcasts. */
  tabId: string;
  kind: SyncKind;
  docId?: string;
}

export const SYNC_CHANNEL = "figma-lite:library";

let tabCounter = 0;

function newTabId(): string {
  tabCounter += 1;
  return `tab-${Date.now().toString(36)}-${tabCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface SyncOptions {
  channelName?: string;
  /** Injectable for tests; defaults to the global constructor. */
  factory?: ((name: string) => BroadcastChannel) | null;
}

export class LibrarySync {
  readonly tabId = newTabId();
  private channel: BroadcastChannel | null = null;

  constructor(onMessage: (message: SyncMessage) => void, options: SyncOptions = {}) {
    const name = options.channelName ?? SYNC_CHANNEL;
    const factory =
      options.factory === undefined
        ? typeof BroadcastChannel !== "undefined"
          ? (n: string) => new BroadcastChannel(n)
          : null
        : options.factory;

    if (!factory) return;

    try {
      this.channel = factory(name);
      this.channel.onmessage = (event: MessageEvent) => {
        const message = event.data as SyncMessage | undefined;
        if (!message || typeof message.tabId !== "string") return;
        // A tab hears its own posts on some implementations; never act on them.
        if (message.tabId === this.tabId) return;
        onMessage(message);
      };
    } catch {
      this.channel = null;
    }
  }

  get isActive(): boolean {
    return this.channel !== null;
  }

  post(kind: SyncKind, docId?: string): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage({ tabId: this.tabId, kind, docId } satisfies SyncMessage);
    } catch {
      // A closed channel or an unclonable payload must not break saving.
    }
  }

  close(): void {
    try {
      this.channel?.close();
    } catch {
      // Already closed.
    }
    this.channel = null;
  }
}
