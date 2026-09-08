/**
 * `GET/PUT/DELETE /api/house-model/[modelId]/annotations` and the endpoints resource.
 *
 * Annotations are the cheapest durable knowledge in the app, so the assertions are about not
 * losing them: a pin whose node the package forgets keeps its words and is reported, a measurement
 * cannot be stored with nothing measured, and a delete really deletes (a "removed" warning that
 * still reads as advice would be worse than none).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SESSION_USER_ID } = vi.hoisted(() => ({
  SESSION_USER_ID: "01900000-0000-7000-8000-000000000001",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: SESSION_USER_ID } }),
  requireFreshSession: async () => ({ user: { id: SESSION_USER_ID } }),
  getSession: async () => ({ user: { id: SESSION_USER_ID } }),
  UnauthorizedError: class UnauthorizedError extends Error {
    readonly status = 401 as const;
  },
}));

import { eq } from "drizzle-orm";
import { annotation, modelRevision } from "@/db/schema";
import {
  DELETE as DELETE_ANNOTATION,
  GET as GET_ANNOTATIONS,
  PUT as PUT_ANNOTATION,
} from "@/app/api/house-model/[modelId]/annotations/route";
import {
  DELETE as DELETE_ENDPOINT,
  GET as GET_ENDPOINTS,
  PUT as PUT_ENDPOINT,
} from "@/app/api/house-model/[modelId]/endpoints/route";
import type { AnnotationDto, EndpointDto } from "@/features/projects/wire";
import {
  bodyOf,
  ctx,
  jsonRequest,
  seedAsset,
  setupHarness,
  teardownHarness,
  type Harness,
} from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await setupHarness();
});

afterEach(() => {
  teardownHarness(h);
});

const putAnnotation = (over: Record<string, unknown> = {}) =>
  PUT_ANNOTATION(
    jsonRequest(`/api/house-model/${h.modelId}/annotations`, "PUT", {
      fingerprint: h.fingerprint,
      viewMode: "normal",
      annotation: {
        targetKind: "node",
        modelNodeId: "r-l-a",
        position: [1.5, 1.2, 1.5],
        kind: "note",
        title: "Shutoff behind this panel",
        body: "Quarter-turn valve, 20 cm left of the hatch edge.",
        ...over,
      },
    }),
    ctx({ modelId: h.modelId }),
  );

describe("annotations CRUD", () => {
  it("creates, lists, updates and deletes a pin", async () => {
    const created = await bodyOf<{ annotation: AnnotationDto }>(await putAnnotation());
    expect(created.annotation.title).toBe("Shutoff behind this panel");
    expect(created.annotation.position).toEqual([1.5, 1.2, 1.5]);
    expect(created.annotation.modelNodeId).toBe("r-l-a");

    const listed = await bodyOf<{ annotations: AnnotationDto[]; stale: string[] }>(
      await GET_ANNOTATIONS(
        jsonRequest(`/api/house-model/${h.modelId}/annotations`, "GET"),
        ctx({ modelId: h.modelId }),
      ),
    );
    expect(listed.annotations).toHaveLength(1);
    expect(listed.stale).toEqual([]);

    const updated = await bodyOf<{ annotation: AnnotationDto }>(
      await putAnnotation({ id: created.annotation.id, kind: "warning", title: "Do not drill" }),
    );
    expect(updated.annotation.id).toBe(created.annotation.id);
    expect(updated.annotation.kind).toBe("warning");
    expect(h.handle.db.select().from(annotation).all()).toHaveLength(1);

    const deleted = await DELETE_ANNOTATION(
      jsonRequest(
        `/api/house-model/${h.modelId}/annotations?id=${created.annotation.id}`,
        "DELETE",
      ),
      ctx({ modelId: h.modelId }),
    );
    expect(deleted.status).toBe(204);
    expect(h.handle.db.select().from(annotation).all()).toHaveLength(0);
  });

  it("stores a measurement with its value and unit", async () => {
    const { annotation: pin } = await bodyOf<{ annotation: AnnotationDto }>(
      await putAnnotation({
        kind: "measurement",
        title: "Ceiling height at the ridge",
        measurementValue: 2.34,
        measurementUnit: "m",
      }),
    );
    expect(pin.measurementValue).toBe(2.34);
    expect(pin.measurementUnit).toBe("m");
  });

  it("refuses a measurement with nothing measured", async () => {
    const res = await putAnnotation({ kind: "measurement", measurementValue: null });
    expect(res.status).toBe(400);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({
      error: "measurement_needs_a_value",
    });
  });

  it("refuses a pin with nothing to point at", async () => {
    const res = await putAnnotation({ modelNodeId: null, position: null, targetId: null });
    expect(res.status).toBe(400);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({
      error: "annotation_needs_an_anchor",
    });
  });

  it("refuses a presentation coordinate (422) and a node the package does not know (400)", async () => {
    const exploded = await PUT_ANNOTATION(
      jsonRequest(`/api/house-model/${h.modelId}/annotations`, "PUT", {
        fingerprint: h.fingerprint,
        viewMode: "cutaway",
        annotation: { targetKind: "node", modelNodeId: "r-l-a", kind: "note", title: "x" },
      }),
      ctx({ modelId: h.modelId }),
    );
    expect(exploded.status).toBe(422);

    const badNode = await putAnnotation({ modelNodeId: "r-nope" });
    expect(badNode.status).toBe(400);
    expect(await bodyOf<{ error: string }>(badNode)).toMatchObject({
      error: "unknown_model_node",
    });
  });

  it("answers 409 model_revision_missing before the first import", async () => {
    h.handle.db.delete(modelRevision).where(eq(modelRevision.id, h.revisionId)).run();
    const res = await putAnnotation();
    expect(res.status).toBe(409);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: "model_revision_missing" });
  });

  it("keeps the words of a pin whose node the package forgot, and reports it as stale", async () => {
    const created = await bodyOf<{ annotation: AnnotationDto }>(await putAnnotation());
    h.handle.db
      .update(annotation)
      .set({ modelNodeId: "r-demolished" })
      .where(eq(annotation.id, created.annotation.id))
      .run();

    const listed = await bodyOf<{ annotations: AnnotationDto[]; stale: string[] }>(
      await GET_ANNOTATIONS(
        jsonRequest(`/api/house-model/${h.modelId}/annotations`, "GET"),
        ctx({ modelId: h.modelId }),
      ),
    );
    expect(listed.stale).toEqual([created.annotation.id]);
    expect(listed.annotations[0]?.title).toBe("Shutoff behind this panel");
    expect(listed.annotations[0]?.needsReconciliation).toBe(true);
  });
});

describe("endpoints CRUD", () => {
  const putEndpoint = (over: Record<string, unknown> = {}) =>
    PUT_ENDPOINT(
      jsonRequest(`/api/house-model/${h.modelId}/endpoints`, "PUT", {
        fingerprint: h.fingerprint,
        viewMode: "normal",
        endpoint: {
          name: "Main shutoff",
          kind: "shutoff",
          modelNodeId: "r-l-b",
          position: [2, 0.3, 2],
          ...over,
        },
      }),
      ctx({ modelId: h.modelId }),
    );

  it("creates, lists and deletes an endpoint", async () => {
    const created = await bodyOf<{ endpoint: EndpointDto }>(await putEndpoint());
    expect(created.endpoint.kind).toBe("shutoff");
    expect(created.endpoint.position).toEqual([2, 0.3, 2]);

    const listed = await bodyOf<{ endpoints: EndpointDto[] }>(
      await GET_ENDPOINTS(
        jsonRequest(`/api/house-model/${h.modelId}/endpoints`, "GET"),
        ctx({ modelId: h.modelId }),
      ),
    );
    expect(listed.endpoints).toHaveLength(1);

    const deleted = await DELETE_ENDPOINT(
      jsonRequest(
        `/api/house-model/${h.modelId}/endpoints?id=${created.endpoint.id}`,
        "DELETE",
      ),
      ctx({ modelId: h.modelId }),
    );
    expect(deleted.status).toBe(204);
  });

  it("accepts a location-only endpoint with no coordinates", async () => {
    const assetId = seedAsset(h.handle, "Distribution board");
    const created = await bodyOf<{ endpoint: EndpointDto }>(
      await putEndpoint({ position: null, assetId, name: "Board", kind: "panel" }),
    );
    expect(created.endpoint.position).toBeNull();
    expect(created.endpoint.assetId).toBe(assetId);
  });

  it("refuses an endpoint nobody could find", async () => {
    const res = await putEndpoint({ position: null, modelNodeId: null });
    expect(res.status).toBe(400);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({
      error: "endpoint_needs_a_place",
    });
  });

  it("refuses an unknown asset reference", async () => {
    const res = await putEndpoint({ assetId: "nope" });
    expect(res.status).toBe(409);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: "unknown_asset" });
  });

  it("404s deleting an endpoint that does not exist, and 400s with no id", async () => {
    expect(
      (
        await DELETE_ENDPOINT(
          jsonRequest(`/api/house-model/${h.modelId}/endpoints?id=nope`, "DELETE"),
          ctx({ modelId: h.modelId }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await DELETE_ENDPOINT(
          jsonRequest(`/api/house-model/${h.modelId}/endpoints`, "DELETE"),
          ctx({ modelId: h.modelId }),
        )
      ).status,
    ).toBe(400);
  });
});
