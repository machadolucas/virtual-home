import type { Page } from "@playwright/test";

export interface SyntheticHaItem {
  topic: "ha.state";
  key: string;
  payload: {
    state: string;
    attributes?: Record<string, unknown>;
    lastUpdated?: number;
  };
}

/** Install before navigation. Tests can then drive the browser's real SSE parser deterministically. */
export async function installSyntheticHa(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sources = new Set<EventTarget>();
    class SyntheticEventSource extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 0;
      constructor(_url: string | URL, _init?: EventSourceInit) {
        super();
        void _url;
        void _init;
        sources.add(this);
      }
      close() {
        this.readyState = SyntheticEventSource.CLOSED;
        sources.delete(this);
      }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: SyntheticEventSource });
    (window as unknown as { __vhSyntheticHa: { emit(type: string, data?: unknown): void } })
      .__vhSyntheticHa = {
        emit(type, data) {
          for (const source of sources) {
            const event = type === "open"
              ? new Event("open")
              : new MessageEvent(type, { data: JSON.stringify(data ?? {}) });
            source.dispatchEvent(event);
          }
        },
      };
  });
}

export async function openSyntheticHa(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __vhSyntheticHa: { emit(type: string): void } })
      .__vhSyntheticHa.emit("open");
  });
}

export async function emitHaBatch(page: Page, items: readonly SyntheticHaItem[], seq = 1): Promise<void> {
  await page.evaluate(
    ({ items, seq }) => {
      (window as unknown as { __vhSyntheticHa: { emit(type: string, data: unknown): void } })
        .__vhSyntheticHa.emit("batch", { seq, items });
    },
    { items, seq },
  );
}
