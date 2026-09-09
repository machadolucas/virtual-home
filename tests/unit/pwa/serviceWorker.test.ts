import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerEvent = {
  request?: Pick<Request, "method" | "mode" | "url">;
  respondWith?: (response: Promise<Response | undefined>) => void;
};

function workerHarness() {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const fetch = vi.fn<(request: Request) => Promise<Response>>();
  const cachedOffline = new Response("Connection required", { status: 200 });
  const cache = {
    addAll: vi.fn(),
    match: vi.fn(),
    put: vi.fn(),
  };
  const caches = {
    open: vi.fn(async () => cache),
    match: vi.fn(async (value: string | Request) =>
      value === "/offline.html" ? cachedOffline : undefined,
    ),
    keys: vi.fn(async () => []),
    delete: vi.fn(),
  };
  const self = {
    location: { origin: "https://home.example" },
    addEventListener: (name: string, listener: (event: WorkerEvent) => void) =>
      listeners.set(name, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };

  const source = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { self, caches, fetch, URL, Response, Promise });

  return { fetch, listeners };
}

describe("PWA service worker privacy boundary", () => {
  it.each(["/today", "/api/events", "/api/house-model/house/status"])(
    "leaves authenticated request %s network-only",
    (pathname) => {
      const { listeners } = workerHarness();
      const respondWith = vi.fn();
      listeners.get("fetch")?.({
        request: new Request(`https://home.example${pathname}`),
        respondWith,
      });

      expect(respondWith).not.toHaveBeenCalled();
    },
  );

  it("falls back to the household-neutral offline document for a failed navigation", async () => {
    const { fetch, listeners } = workerHarness();
    fetch.mockRejectedValueOnce(new TypeError("offline"));
    let response: Promise<Response | undefined> | undefined;

    listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://home.example/today",
      },
      respondWith: (value) => {
        response = value;
      },
    });

    expect(await response).toHaveProperty("status", 200);
    expect(await (await response)?.text()).toBe("Connection required");
  });

  it("handles only public static assets through the runtime cache", async () => {
    const { fetch, listeners } = workerHarness();
    fetch.mockResolvedValueOnce(new Response("chunk", { status: 200 }));
    let response: Promise<Response | undefined> | undefined;
    listeners.get("fetch")?.({
      request: new Request("https://home.example/_next/static/chunks/app.js"),
      respondWith: (value) => {
        response = value;
      },
    });

    expect(await (await response)?.text()).toBe("chunk");
  });
});
