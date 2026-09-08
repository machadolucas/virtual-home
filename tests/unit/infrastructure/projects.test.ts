/**
 * Project writes and the polymorphic link validation.
 *
 * `project_link` is the one place in this slice where SQLite cannot enforce the reference, so the
 * service layer has to. What is asserted here is that it actually does — and that deleting a
 * project deletes the **container**, never the equipment, completions or routes it pointed at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SESSION_USER_ID } = vi.hoisted(() => ({
  SESSION_USER_ID: "01900000-0000-7000-8000-000000000001",
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: SESSION_USER_ID } }),
  requireFreshSession: async () => ({ user: { id: SESSION_USER_ID } }),
  getSession: async () => ({ user: { id: SESSION_USER_ID } }),
  UnauthorizedError: class UnauthorizedError extends Error {
    readonly status = 401 as const;
  },
}));

import { asset, project, projectLink } from "@/db/schema";
import {
  addProjectLink,
  createProject,
  deleteProject,
  removeProjectLink,
  updateProject,
} from "@/server/actions/infrastructure/projects";
import { linkCandidates, listProjects, readProject } from "@/server/queries/infrastructure/projects";
import { seedAsset, setupHarness, teardownHarness, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await setupHarness();
});

afterEach(() => {
  teardownHarness(h);
});

/** Unwrap an `ActionResult`, failing the test with the server's own code when it is not ok. */
function ok<T>(result: { ok: true; data: T } | { ok: false; error: string; details?: unknown }): T {
  if (!result.ok) throw new Error(`action failed: ${result.error}`);
  return result.data;
}

const fields = {
  name: "Bathroom renovation",
  kind: "renovation" as const,
  status: "in_progress" as const,
  startedOn: "2024-03-01",
  endedOn: null,
  budgetCents: 450000,
  actualCostCents: 481240,
  currency: "EUR",
  summary: "New floor drain, tiles and ventilation.",
  notes: null,
};

describe("createProject / updateProject", () => {
  it("stores the costs as integer cents", async () => {
    const { id } = ok(await createProject(fields));
    const row = h.handle.db.select().from(project).all()[0];
    expect(row?.id).toBe(id);
    expect(row?.budgetCents).toBe(450000);
    expect(row?.actualCostCents).toBe(481240);
    expect(row?.currency).toBe("EUR");

    const summaries = listProjects(h.handle.db);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.linkCount).toBe(0);
  });

  it("refuses an end date with no start date, and an end before the start", async () => {
    const noStart = await createProject({ ...fields, startedOn: null, endedOn: "2024-06-01" });
    expect(noStart.ok).toBe(false);
    if (!noStart.ok) expect(noStart.error).toBe("ended_without_started");

    const backwards = await createProject({
      ...fields,
      startedOn: "2024-06-01",
      endedOn: "2024-03-01",
    });
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.error).toBe("ended_before_started");
  });

  it("updates the row it is given, and 404s on one that is gone", async () => {
    const { id } = ok(await createProject(fields));
    ok(await updateProject({ ...fields, id, status: "done", endedOn: "2024-06-01" }));
    const row = h.handle.db.select().from(project).all()[0];
    expect(row?.status).toBe("done");
    expect(row?.endedOn).toBe("2024-06-01");

    const missing = await updateProject({ ...fields, id: "nope" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe("not_found");
  });
});

describe("project links", () => {
  it("refuses a link to something that does not exist", async () => {
    const { id } = ok(await createProject(fields));
    const result = await addProjectLink({
      projectId: id,
      entityKind: "asset",
      entityId: "does-not-exist",
      role: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_found");
    expect(h.handle.db.select().from(projectLink).all()).toHaveLength(0);
  });

  it("links something that does exist, and resolves its name back", async () => {
    const { id } = ok(await createProject(fields));
    const assetId = seedAsset(h.handle, "Floor drain");
    ok(
      await addProjectLink({
        projectId: id,
        entityKind: "asset",
        entityId: assetId,
        role: "replaced",
      }),
    );

    const detail = readProject(h.handle.db, id);
    expect(detail?.links).toHaveLength(1);
    expect(detail?.links[0]).toMatchObject({
      entityKind: "asset",
      entityId: assetId,
      role: "replaced",
      label: "Floor drain",
    });
  });

  it("refuses the same link twice", async () => {
    const { id } = ok(await createProject(fields));
    const assetId = seedAsset(h.handle);
    ok(await addProjectLink({ projectId: id, entityKind: "asset", entityId: assetId, role: null }));
    const again = await addProjectLink({
      projectId: id,
      entityKind: "asset",
      entityId: assetId,
      role: null,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("link_exists");
  });

  it("shows a link whose target has since disappeared as missing, never as a plausible name", () => {
    const projectId = "01900000-0000-7000-8000-0000000000aa";
    h.handle.sqlite
      .prepare(
        `INSERT INTO project (id, name, kind, status, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?)`,
      )
      .run(projectId, "Old works", "repair", "done", Date.now(), Date.now());
    h.handle.sqlite
      .prepare(
        `INSERT INTO project_link (id, project_id, entity_kind, entity_id) VALUES (?,?,?,?)`,
      )
      .run("link-1", projectId, "asset", "vanished");

    const detail = readProject(h.handle.db, projectId);
    expect(detail?.links[0]?.label).toBeNull();
    expect(detail?.links[0]?.entityId).toBe("vanished");
  });

  it("unlinks without touching what was linked", async () => {
    const { id } = ok(await createProject(fields));
    const assetId = seedAsset(h.handle, "Extractor fan");
    ok(await addProjectLink({ projectId: id, entityKind: "asset", entityId: assetId, role: null }));
    const linkId = h.handle.db.select().from(projectLink).all()[0]?.id as string;

    ok(await removeProjectLink({ linkId }));
    expect(h.handle.db.select().from(projectLink).all()).toHaveLength(0);
    expect(h.handle.db.select().from(asset).all()).toHaveLength(1);
  });

  it("offers pickable candidates for the kinds that have names", async () => {
    const assetId = seedAsset(h.handle, "Floor drain");
    const candidates = linkCandidates(h.handle.db);
    expect(candidates.asset).toEqual([{ id: assetId, label: "Floor drain" }]);
    // Tasks and completions are deliberately not offered here.
    expect(candidates.occurrence).toBeUndefined();
    expect(candidates.completion).toBeUndefined();
  });
});

describe("deleteProject", () => {
  it("removes the container and its links, and nothing they pointed at", async () => {
    const { id } = ok(await createProject(fields));
    const assetId = seedAsset(h.handle, "Floor drain");
    ok(await addProjectLink({ projectId: id, entityKind: "asset", entityId: assetId, role: null }));

    ok(await deleteProject({ id }));
    expect(h.handle.db.select().from(project).all()).toHaveLength(0);
    expect(h.handle.db.select().from(projectLink).all()).toHaveLength(0);
    expect(h.handle.db.select().from(asset).all()).toHaveLength(1);
  });

  it("404s on a project that is already gone", async () => {
    const result = await deleteProject({ id: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_found");
  });
});
