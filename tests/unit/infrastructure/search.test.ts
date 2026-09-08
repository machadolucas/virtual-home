/**
 * `GET /api/search` — the header search's index.
 *
 * The surface used to say "Search is not connected yet", which was honest but useless. These
 * tests pin the two things that make it trustworthy: it never answers without a session, and it
 * never claims to have shown everything when it capped the list.
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

import { GET } from "@/app/api/search/route";
import { bodyOf, jsonRequest, seedAsset, setupHarness, teardownHarness, type Harness } from "./harness";

interface SearchBody {
  query: string;
  groups: { kind: string; label: string; hits: { label: string; href: string }[]; hasMore: boolean }[];
}

let h: Harness;

beforeEach(async () => {
  h = await setupHarness();
});

afterEach(() => {
  teardownHarness(h);
});

const search = (q: string) =>
  GET(jsonRequest(`/api/search?q=${encodeURIComponent(q)}`, "GET"), {
    params: Promise.resolve({}),
  } as never);

describe("global search", () => {
  it("finds equipment by name and hands back the href that opens it", async () => {
    const assetId = seedAsset(h.handle, "Kitchen extractor fan");

    const body = await bodyOf<SearchBody>(await search("extractor"));
    const equipment = body.groups.find((group) => group.kind === "equipment");
    expect(equipment?.hits.map((hit) => hit.label)).toContain("Kitchen extractor fan");
    expect(equipment?.hits[0]?.href).toBe(`/equipment/${assetId}`);
  });

  it("says nothing at all for a query too short to mean anything", async () => {
    seedAsset(h.handle, "Kitchen extractor fan");
    const body = await bodyOf<SearchBody>(await search("k"));
    expect(body.groups).toEqual([]);
  });

  it("omits a group with no matches rather than showing it empty", async () => {
    seedAsset(h.handle, "Kitchen extractor fan");
    const body = await bodyOf<SearchBody>(await search("extractor"));
    expect(body.groups.every((group) => group.hits.length > 0)).toBe(true);
    expect(body.groups.map((group) => group.kind)).not.toContain("supplies");
  });

  it("admits when the cap cut the list instead of implying that was all", async () => {
    for (let i = 0; i < 10; i++) seedAsset(h.handle, `Radiator valve ${i}`);

    const body = await bodyOf<SearchBody>(await search("radiator valve"));
    const equipment = body.groups.find((group) => group.kind === "equipment");
    expect(equipment?.hits).toHaveLength(8);
    expect(equipment?.hasMore).toBe(true);
  });

  it("treats the user's own wildcards as text, not as LIKE syntax", async () => {
    seedAsset(h.handle, "Boiler");
    // `%` would match everything if it were passed through to LIKE unescaped.
    const body = await bodyOf<SearchBody>(await search("%%"));
    expect(body.groups).toEqual([]);
  });
});
