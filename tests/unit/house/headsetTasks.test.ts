import { afterEach, expect, it, vi } from "vitest";
import { HeadsetTasks } from "@/house/xr/headsetTasks";
import { contains, layoutPanel } from "@/house/xr/panelLayout";
import type { HeadsetMaintenanceOverview, HeadsetMaintenanceTask } from "@/house/xr/headsetTasksTypes";
import type { HouseRuntime } from "@/house/runtime";

const target = {
  id: "asset-a", kind: "equipment", name: "Sample fan", placementId: "placement-a", roomId: "room-a",
  floorId: "floor-a", roomName: "Sample room", floorName: "Ground floor", assetId: "asset-a",
  endpointId: null, routeIds: [], position: [0, 1, 0], category: "hvac", modelName: "Unit 123", servedFixtures: [],
} satisfies HeadsetMaintenanceOverview["target"];

const task = { id: "task-a", title: "Change synthetic filter", status: "due", dueDate: "2026-02-01", priority: "normal" } as const;
const detail: HeadsetMaintenanceTask = {
  ...task, description: null, procedure: {
    procedureId: "procedure", procedureTitle: "Filter change", versionId: "superseded", version: 1, status: "superseded",
    publishedAtMs: 100, summary: null, prerequisites: null, safetyNotes: null,
    steps: [
      { id: "step-1", seq: 0, title: "Open access lid", bodyMd: "Follow the documented release.", warning: null,
        expectedMinutes: null, isOptional: false, checklist: [] },
      { id: "step-2", seq: 1, title: "Replace element", bodyMd: "Fit the documented part.", warning: null,
        expectedMinutes: null, isOptional: false, checklist: [] },
    ],
    looseChecklist: [], tools: [], references: [], equipmentNotes: [],
  },
  progress: [], materials: [], requiresProfessional: false, providers: [], photos: [],
  illustrations: [{ stepId: "step-1", previews: [{ attachmentId: "asset-illustration", kind: "image", label: "Filter lid" }] }],
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps the QWERTY keys stable while debouncing, discarding stale matches and opening a current result", async () => {
  vi.useFakeTimers();
  const calls: {
    query: string | null;
    signal: AbortSignal | null | undefined;
    respond: (response: Response) => void;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (path: string, init?: RequestInit) =>
        new Promise<Response>((respond) => {
          const params = new URL(path, "https://fixture.invalid").searchParams;
          expect(params.get("roomId")).toBe("room-a");
          calls.push({ query: params.get("q"), signal: init?.signal, respond });
        }),
    ),
  );
  const state = new HeadsetTasks({ base: "/api/fixture" } as HouseRuntime, {
    locate: vi.fn(),
    openPinned: vi.fn(),
    tell: vi.fn(),
    exit: vi.fn(),
  });
  const act = () => {};
  const layout = () => layoutPanel(state.menu(), (value) => value.length * 14, act, act);
  const clickKey = (id: string) => layout().rows.find((row) => row.id === id)!.act!(0.5);
  state.find("room-a");
  state.menu().rows.find((row) => row.label === "Search by name or model")!.act!(0.5);
  const empty = layout();
  expect(
    empty.rows
      .slice(0, 10)
      .map(({ label }) => label)
      .join(""),
  ).toBe("qwertyuiop");
  const [q, w] = empty.rows;
  expect(contains(q!, q!.x + q!.width + 2, q!.y + q!.height / 2)).toBe(false);
  expect(contains(w!, q!.x + q!.width + 2, q!.y + q!.height / 2)).toBe(false);
  clickKey("symbols");
  expect(
    layout()
      .rows.slice(0, 10)
      .map(({ label }) => label)
      .join(""),
  ).toBe("1234567890");
  clickKey("symbols");
  clickKey("char-f");
  clickKey("char-a");
  expect(calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(250);
  expect(calls.map(({ query }) => query)).toEqual(["fa"]);
  clickKey("char-n");
  expect(calls[0]?.signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  const replies = [
    target,
    ...[2, 3, 4].map((id) => ({ ...target, id: `asset-${id}`, name: `Fixture fan ${id}` })),
  ];
  calls[1]?.respond(Response.json({ items: replies, nextOffset: 24 }));
  await vi.advanceTimersByTimeAsync(0);
  const matchKeys = state.menu().rows;
  expect(matchKeys.map(({ label }) => label)).toEqual([
    "Sample fan",
    "Fixture fan 2",
    "Fixture fan 3",
    "View all matches",
  ]);
  expect(layout().height).toBe(empty.height);
  expect(layout().maxScroll).toBe(0);
  calls[0]?.respond(Response.json({ items: [{ ...target, name: "Stale" }], nextOffset: null }));
  await vi.advanceTimersByTimeAsync(0);
  expect(state.menu().rows[0]?.label).toBe("Sample fan");
  matchKeys[0]?.act?.(0.5);
  expect(state.menu().title).toBe("Sample fan");
  state.back();
  expect(state.menu().keyboard?.text).toBe("fan");
  matchKeys[3]?.act?.(0.5);
  expect(state.menu().rows.some(({ label }) => label === "Fixture fan 4")).toBe(true);
  state.back();
  clickKey("clear");
  matchKeys[0]?.act?.(0.5);
  expect(state.menu().rows).toEqual([]);
  expect(state.menu().keyboard?.text).toBe("");
  clickKey("char-f");
  state.back();
  await vi.advanceTimersByTimeAsync(250);
  expect(calls).toHaveLength(2);
  state.dispose();
});

it("uses a numeric keypad with sign, decimal, clear and explicit submit", async () => {
  const withChecklist = {
    ...detail,
    procedure: {
      ...detail.procedure!,
      looseChecklist: [{ id: "level", text: "Reading", stepId: null, requiresValue: "number", unit: "Pa" }],
    },
  };
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({});
      }
      return Response.json(
        input.includes("?task=") ? withChecklist : { target, tasks: [task], lastWork: null, parts: [] },
      );
    }),
  );
  const state = new HeadsetTasks({ base: "/api/fixture" } as HouseRuntime, {
    locate: vi.fn(),
    openPinned: vi.fn(),
    tell: vi.fn(),
    exit: vi.fn(),
  });
  const click = (label: string) => state.menu().rows.find((row) => row.label === label)!.act!(0.5);
  const findKey = (id: string) =>
    state
      .menu()
      .keyboard?.keys.flat()
      .find((key) => key.id === id);
  const key = (id: string) => findKey(id)!.act!(0.5);
  state.maintenance("placement-a");
  await vi.waitFor(() => expect(state.menu().rows.some(({ label }) => label === task.title)).toBe(true));
  click(task.title);
  await vi.waitFor(() =>
    expect(state.menu().rows.some(({ label }) => label === "Task checklist")).toBe(true),
  );
  click("Task checklist");
  click("Reading");
  expect(
    state
      .menu()
      .keyboard?.keys.slice(0, 3)
      .map((row) => row.map(({ label }) => label).join("")),
  ).toEqual(["789", "456", "123"]);
  expect(findKey("accept")?.act).toBeUndefined();
  key("char-7");
  key("clear");
  expect(state.menu().keyboard?.text).toBe("");
  key("sign");
  key("char-2");
  key("char-.");
  expect(findKey("char-.")?.act).toBeUndefined();
  key("char-1");
  key("erase");
  key("char-5");
  expect(state.menu().keyboard?.text).toBe("-2.5");
  expect(writes).toHaveLength(0);
  key("accept");
  await vi.waitFor(() =>
    expect(writes).toEqual([
      { kind: "checklist", occurrenceId: task.id, itemId: "level", state: "done", value: -2.5 },
    ]),
  );
  state.dispose();
});

it("labels a fallback air handler and locates its documented position", async () => {
  const airHandler = { ...target, finding: "air_handler_filter_unrecorded" } as const;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [airHandler], nextOffset: null })));
  const actions = { locate: vi.fn(), openPinned: vi.fn(), tell: vi.fn(), exit: vi.fn() };
  const state = new HeadsetTasks({ base: "/api/fixture" } as HouseRuntime, actions);
  state.find();
  state.menu().rows.find(({ label }) => label === "Find the ventilation filter")!.act!(.5);
  await vi.waitFor(() => expect(state.menu().rows[0]?.detail).toBe("Filter position unrecorded"));
  expect(state.menu().rows[0]?.label).toBe("Air handler · Sample fan");
  state.menu().rows[0]?.act?.(.5);
  expect(state.menu().lines).toContain("Air handler · filter position unrecorded");
  state.menu().rows.find(({ label }) => label === "Locate in house")!.act!(.5);
  expect(actions.locate).toHaveBeenCalledWith(airHandler);
  state.dispose();
});

it("keeps the deliberate pinned step and writes completion only after a distinct review and confirm", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ completionId: "recorded-once" });
    }
    if (input.includes("?task=")) return Response.json(detail);
    return Response.json({ target, tasks: [task], lastWork: null, parts: [] });
  }));
  const actions = { locate: vi.fn(), openPinned: vi.fn(), tell: vi.fn(), exit: vi.fn() };
  const state = new HeadsetTasks({ base: "/api/fixture" } as HouseRuntime, actions);
  const click = (label: string) => state.menu().rows.find((row) => row.label === label)!.act!(.5);
  state.maintenance("placement-a");
  await vi.waitFor(() => expect(state.menu().title).toBe("Sample fan"));
  click(task.title);
  await vi.waitFor(() => expect(state.menu().title).toBe(task.title));
  click("Open current step");
  click("Pin step beside equipment");
  expect(actions.openPinned).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Open access lid",
    illustration: { attachmentId: "asset-illustration", label: "Filter lid", kind: "image" } }));
  click("Next step");
  expect(actions.openPinned).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Replace element", index: 2 }));
  state.back();
  click("Review completion");
  click("Continue to confirmation");
  expect(writes).toHaveLength(0);
  click("Record completion now");
  await vi.waitFor(() => expect(actions.tell).toHaveBeenCalledWith("Maintenance completion recorded."));
  expect(writes).toEqual([{ kind: "complete", occurrenceId: task.id, requestId: expect.any(String),
    confirmed: true, outcome: "done", materials: [] }]);
  expect(actions.openPinned).toHaveBeenLastCalledWith(null);
  state.dispose();
});
