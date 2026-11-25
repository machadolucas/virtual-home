import { afterEach, expect, it, vi } from "vitest";
import { connectHaSse, ventilationStateKey } from "@/house/store/haSse";
import { haStore } from "@/house/store/haStore";

const source = new EventTarget();
class TestEventSource {
  addEventListener = source.addEventListener.bind(source);
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  haStore.getState().reset();
});

function frame(event: "hello" | "batch", items: object[]) {
  source.dispatchEvent(new MessageEvent(event, { data: JSON.stringify({ seq: 1, items }) }));
}

it("tracks bound feedback by stable identity and clears it when the replacement snapshot omits it", () => {
  vi.stubGlobal("EventSource", TestEventSource);
  const handle = connectHaSse({ entityIds: [], ventilationRegistryIds: ["fixture-supply"] });
  try {
    const key = ventilationStateKey("fixture-supply");
    const status = { topic: "integration.status", key: "ha", payload: { state: "subscribed" } };
    const state = {
      topic: "ha.state", key: "sensor.original",
      payload: { registryId: "fixture-supply", state: "45", lastUpdated: 1, lastReported: 2, observedAt: 3,
        attributes: { unit_of_measurement: "%" } },
    };
    source.dispatchEvent(new Event("open"));
    frame("hello", [status, state]);
    expect(haStore.getState().haConnected).toBe(true);
    expect(haStore.getState().entities[key]).toMatchObject({
      state: "45", unit: "%", lastUpdated: 1, lastReported: 2, observedAt: 3,
    });
    expect(haStore.getState().entities["sensor.original"]).toBeUndefined();

    frame("batch", [{ ...state, key: "sensor.renamed", payload: { ...state.payload, state: "58" } }]);
    expect(haStore.getState().entities[key]?.state).toBe("58");
    frame("batch", [{ ...status, payload: { state: "degraded" } }]);
    expect(haStore.getState().haConnected).toBe(false);
    frame("hello", [status]);
    expect(haStore.getState().entities[key]).toBeUndefined();
  } finally {
    handle.close();
  }
});
