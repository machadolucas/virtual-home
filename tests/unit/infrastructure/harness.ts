/**
 * Shared setup for the infrastructure route-handler tests.
 *
 * The handlers are invoked **directly** (`GET(req, ctx)`), not through a running Next server: they
 * are plain functions of a `Request`, so a direct call exercises the real zod validation, the real
 * SQL and the real error mapping without a port, a build or a browser.
 *
 * Two things have to be true for that to work, and both are set up here:
 *  - a `VH_DATA_DIR` of its own per test file, with the **synthetic fixture** package installed
 *    (the real package never enters this repo — CLAUDE.md rule 1);
 *  - a fresh in-memory database built by the real migrations, installed as the process-wide handle
 *    with `setDbForTests`, so `getDb()` inside a handler finds it.
 *
 * `vi.mock` cannot live here: the calls are hoisted per *module*, so each test file declares its
 * own session mock. `SESSION_USER` is the id those mocks hand out and the id seeded below, because
 * `created_by` is a real foreign key to `user`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv, setEnvForTests } from "@/env";
import { openDatabase, setDbForTests, writeTx, type DbHandle } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newId, nowMs } from "@/db/ids";
import { asset, modelRevision, project, user } from "@/db/schema";
import { installPackage, invalidatePackageCache } from "@/server/house-model/package";

export const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/model/house-model");

/** The id every test file's session mock reports, and the `user` row seeded for it. */
export const SESSION_USER = "01900000-0000-7000-8000-000000000001";

export interface Harness {
  handle: DbHandle;
  dataDir: string;
  fingerprint: string;
  modelId: string;
  revisionId: string;
}

/** A data dir with the fixture package installed, plus a migrated in-memory database. */
export async function setupHarness(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-infra-"));
  setEnvForTests(
    parseEnv(
      {
        NODE_ENV: "test",
        VH_DATA_DIR: dataDir,
        VH_BASE_URL: "http://localhost:3010",
        VH_HOUSEHOLD_TZ: "Europe/Helsinki",
        VH_DELIVERY_TIME: "09:00",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
        LOG_LEVEL: "fatal",
      },
      "test",
    ),
  );
  invalidatePackageCache();
  const installed = await installPackage(FIXTURE_DIR);

  const handle = openDatabase(":memory:");
  runMigrations(handle);
  setDbForTests(handle);

  const at = nowMs();
  writeTx(handle.db, (tx) => {
    tx
      .insert(user)
      .values({
        id: SESSION_USER,
        name: "Test User",
        email: "test@virtual-home.local",
        emailVerified: true,
        username: "test",
        displayUsername: "test",
        createdAt: new Date(at),
        updatedAt: new Date(at),
      })
      .run();
  });

  const revisionId = seedRevision(handle, installed.modelId);
  return {
    handle,
    dataDir,
    fingerprint: installed.fingerprint,
    modelId: installed.modelId,
    revisionId,
  };
}

/**
 * The `model_revision` row a spatial write is stamped with. Created by the import pipeline in
 * production; seeded here because "no revision yet" is its own tested behaviour (409).
 */
export function seedRevision(handle: DbHandle, modelId: string, status: "current" = "current"): string {
  const id = newId();
  const at = nowMs();
  writeTx(handle.db, (tx) => {
    tx
      .insert(modelRevision)
      .values({
        id,
        modelId,
        schemaVersion: "1.0",
        generatedAtMs: at,
        contentHash: `test-${id}`,
        coordinateSystemJson: JSON.stringify({
          units: "m",
          up: "y",
          forward: "-z",
          origin: "model-frame",
        }),
        nodeCount: 12,
        importedAtMs: at,
        importedBy: SESSION_USER,
        status,
      })
      .run();
  });
  return id;
}

export function teardownHarness(harness: Harness): void {
  setDbForTests(null);
  harness.handle.close();
  invalidatePackageCache();
  fs.rmSync(harness.dataDir, { recursive: true, force: true });
}

export function seedAsset(handle: DbHandle, name = "Test unit"): string {
  const id = newId();
  const at = nowMs();
  writeTx(handle.db, (tx) => {
    tx
      .insert(asset)
      .values({
        id,
        name,
        category: "plumbing",
        status: "installed",
        createdAtMs: at,
        createdBy: SESSION_USER,
        updatedAtMs: at,
        updatedBy: SESSION_USER,
      })
      .run();
  });
  return id;
}

export function seedProject(handle: DbHandle, name = "Test renovation"): string {
  const id = newId();
  const at = nowMs();
  writeTx(handle.db, (tx) => {
    tx
      .insert(project)
      .values({
        id,
        name,
        kind: "renovation",
        status: "in_progress",
        createdAtMs: at,
        createdBy: SESSION_USER,
        updatedAtMs: at,
        updatedBy: SESSION_USER,
      })
      .run();
  });
  return id;
}

/** A `Request` for a handler, with the JSON body it expects. */
export function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost:3010${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The `ctx` shape a Next route handler receives: params as a promise (Next 16). */
export function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

export async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
