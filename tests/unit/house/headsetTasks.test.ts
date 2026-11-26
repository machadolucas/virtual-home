import { afterEach, expect, it, vi } from "vitest";
import { HeadsetTasks } from "@/house/xr/headsetTasks";
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

afterEach(() => vi.unstubAllGlobals());

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
