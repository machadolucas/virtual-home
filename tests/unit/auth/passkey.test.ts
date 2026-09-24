/**
 * Passkeys through the real `@better-auth/passkey` endpoints, with a software authenticator.
 *
 * The browser half of WebAuthn is replaced by `node:crypto`: a P-256 key pair stands in for the
 * authenticator, its public key is stored the way the plugin stores one (COSE, base64), and each
 * assertion is signed exactly as an authenticator signs it (authenticatorData ‖ SHA-256 of
 * clientDataJSON). Everything on the server side is the production code path: the options
 * endpoint, the signed challenge cookie, `verifyAuthenticationResponse`, `createSession` and the
 * `session.create.before` hook in `buildAuthOptions`.
 *
 * What this pins down:
 *  - the RP ID is the hostname of `VH_BASE_URL`;
 *  - a passkey signs an active member in;
 *  - a deactivated member's passkey is refused and mints no session — the hook covers passkey
 *    sign-in, not only passwords;
 *  - the CLI helpers list and remove passkeys, and a password reset keeps them;
 *  - only an owner can remove another member's passkeys, and that removal is audited;
 *  - a passkey sign-in stamps `lastUsedAt`, a refused one does not;
 *  - every options call leaves a 5-minute challenge row, and pruning removes only expired ones;
 *  - a real registration ceremony with Apple's all-zero AAGUID is named from the user agent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { setDbForTests, writeTx, type DbHandle } from "@/db/client";
import { memberAccess, passkey, session, user, verification } from "@/db/schema";
import { defaultPasskeyName, passkeyProviderName } from "@/domain/passkeyProviders";
import { testDb } from "../../helpers/db";

const BASE = "http://localhost:3010"; // must match VH_BASE_URL in tests/setup.ts
const RP_ID = "localhost";
const PASSWORD = "correct-horse-battery-staple";
const ICLOUD_AAGUID = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd";

let handle: DbHandle;
let web: ReturnType<typeof betterAuth>;
let provisioning: typeof import("@/server/auth/provisioning");

const b64url = (bytes: Buffer): string => bytes.toString("base64url");
/** A fresh client address per request: the per-IP rate limits must not couple these tests. */
const clientIp = (): string => `10.9.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 250) + 1}`;

interface SoftwareKey {
  credentialId: Buffer;
  privateKey: KeyObject;
  counter: number;
}

/** COSE_Key for an ES256 public key: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}. */
function coseEs256(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}

/** Register a software passkey for `userId` by writing the row the plugin would have written. */
function enrol(userId: string, name = "Test key"): SoftwareKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = coseEs256(Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url"));
  const credentialId = randomBytes(16);
  writeTx(handle.db, (tx) =>
    tx
      .insert(passkey)
      .values({
        id: crypto.randomUUID(),
        name,
        publicKey: cose.toString("base64"),
        userId,
        credentialID: b64url(credentialId),
        counter: 0,
        deviceType: "multiDevice",
        backedUp: true,
        transports: "internal",
        createdAt: new Date(),
        aaguid: ICLOUD_AAGUID,
      })
      .run(),
  );
  return { credentialId, privateKey, counter: 0 };
}

/** `name=value` pairs from every Set-Cookie header, ready for a Cookie header. */
function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

/** `between` runs after the options call and before the verify call (e.g. a housekeeping pass). */
async function passkeySignIn(key: SoftwareKey, between?: () => unknown): Promise<Response> {
  const optionsRes = await web.handler(
    new Request(`${BASE}/api/auth/passkey/generate-authenticate-options`, {
      headers: { origin: BASE, "x-forwarded-for": clientIp() },
    }),
  );
  expect(optionsRes.status).toBe(200);
  const options = (await optionsRes.json()) as { challenge: string; rpId: string };
  expect(options.rpId).toBe(RP_ID);
  between?.();

  key.counter += 1;
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: BASE, crossOrigin: false }),
  );
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(key.counter);
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(RP_ID).digest(),
    Buffer.from([0x05]), // user present + user verified
    counter,
  ]);
  const signature = sign(
    "sha256",
    Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
    key.privateKey,
  );

  return web.handler(
    new Request(`${BASE}/api/auth/passkey/verify-authentication`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie: cookiesFrom(optionsRes),
        "x-forwarded-for": clientIp(),
      },
      body: JSON.stringify({
        response: {
          id: b64url(key.credentialId),
          rawId: b64url(key.credentialId),
          type: "public-key",
          response: {
            clientDataJSON: b64url(clientDataJSON),
            authenticatorData: b64url(authenticatorData),
            signature: b64url(signature),
          },
          clientExtensionResults: {},
        },
      }),
    }),
  );
}

/**
 * Only the session-token cookie. The 60 s cookie cache (`vh.session_data`) is left out on purpose,
 * so the server reads the session row — the test ages that row directly.
 */
function sessionCookie(res: Response): string {
  const line = res.headers.getSetCookie().find((c) => c.startsWith("vh.session_token="));
  expect(line).toBeDefined();
  return line!.split(";")[0]!;
}

async function passwordSignIn(username: string, password: string): Promise<Response> {
  return web.handler(
    new Request(`${BASE}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": clientIp() },
      body: JSON.stringify({ username, password }),
    }),
  );
}

async function registerOptions(cookie: string): Promise<Response> {
  return web.handler(
    new Request(`${BASE}/api/auth/passkey/generate-register-options`, {
      headers: { origin: BASE, cookie, "x-forwarded-for": clientIp() },
    }),
  );
}

function ageSession(cookie: string, byMs: number): void {
  const token = decodeURIComponent(cookie.split("=")[1]!).split(".")[0]!;
  const past = new Date(Date.now() - byMs);
  writeTx(handle.db, (tx) => tx.update(session).set({ createdAt: past }).where(eq(session.token, token)).run());
}

function userId(username: string): string {
  return handle.db.select().from(user).where(eq(user.username, username)).get()!.id;
}

function sessionCount(id: string): number {
  return handle.db.select().from(session).where(eq(session.userId, id)).all().length;
}

beforeAll(async () => {
  handle = testDb();
  setDbForTests(handle);
  provisioning = await import("@/server/auth/provisioning");
  const { buildAuthOptions } = await import("@/server/auth/auth");
  web = betterAuth(buildAuthOptions());
  await provisioning.createUser({ username: "lucas", name: "Lucas", password: PASSWORD });
  await provisioning.createUser({ username: "marja", name: "Marja", password: PASSWORD });
});

afterAll(() => {
  setDbForTests(null);
  handle.close();
});

describe("passkey sign-in", () => {
  it("signs an active member in and records the new signature counter", async () => {
    const lucas = userId("lucas");
    const key = enrol(lucas);
    const res = await passkeySignIn(key);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe(lucas);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("vh.session_token="))).toBe(true);
    expect(sessionCount(lucas)).toBe(1);
    const row = handle.db.select().from(passkey).where(eq(passkey.userId, lucas)).get();
    expect(row?.counter).toBe(1);
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - row!.lastUsedAt!.getTime())).toBeLessThan(60_000);
  });

  it("refuses a deactivated member's passkey and mints no session", async () => {
    const marja = userId("marja");
    const key = enrol(marja);
    writeTx(handle.db, (tx) =>
      tx.insert(memberAccess).values({ userId: marja, role: "member", isActive: false, updatedAtMs: Date.now(), updatedBy: null }).run(),
    );
    const res = await passkeySignIn(key);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("vh.session_token="))).toBe(false);
    expect(sessionCount(marja)).toBe(0);
    // Deactivation keeps the passkey: reactivating restores it without re-enrolment.
    const kept = handle.db.select().from(passkey).where(eq(passkey.userId, marja)).all();
    expect(kept).toHaveLength(1);
    // A valid signature that got no session is not a use.
    expect(kept[0]?.lastUsedAt).toBeNull();

    writeTx(handle.db, (tx) => tx.update(memberAccess).set({ isActive: true }).where(eq(memberAccess.userId, marja)).run());
    expect((await passkeySignIn(key)).status).toBe(200);
    expect(sessionCount(marja)).toBe(1);
    expect(handle.db.select().from(passkey).where(eq(passkey.userId, marja)).get()?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("refuses a passkey the server does not know", async () => {
    const stranger: SoftwareKey = {
      credentialId: randomBytes(16),
      privateKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
      counter: 0,
    };
    expect((await passkeySignIn(stranger)).status).toBe(401);
  });
});

describe("passkey registration needs a recent sign-in", () => {
  it("a fresh password session may start registration; the same session 11 minutes later may not", async () => {
    const { PASSKEY_REGISTRATION_MAX_SESSION_AGE_MS } = await import("@/server/auth/auth");
    expect(PASSKEY_REGISTRATION_MAX_SESSION_AGE_MS).toBe(10 * 60 * 1000);
    const signedIn = await passwordSignIn("lucas", PASSWORD);
    expect(signedIn.status).toBe(200);
    const cookie = sessionCookie(signedIn);

    const fresh = await registerOptions(cookie);
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    expect(((await fresh.json()) as { rp: { id: string } }).rp.id).toBe(RP_ID);

    ageSession(cookie, PASSKEY_REGISTRATION_MAX_SESSION_AGE_MS + 60_000);
    const stale = await registerOptions(cookie);
    expect(stale.status).toBe(403);
    await expect(stale.json()).resolves.toMatchObject({ code: "PASSKEY_REAUTH_REQUIRED" });
  });

  it("a session minted by a passkey sign-in counts as fresh too", async () => {
    const key = enrol(userId("lucas"), "Fresh-session key");
    const signedIn = await passkeySignIn(key);
    expect(signedIn.status).toBe(200);
    expect((await registerOptions(sessionCookie(signedIn))).status).toBe(200);
    // Leave the passkey inventory as the provisioning tests below expect it.
    writeTx(handle.db, (tx) => tx.delete(passkey).where(eq(passkey.name, "Fresh-session key")).run());
  });

  it("without a session the endpoint still answers 401, not the re-auth code", async () => {
    const res = await registerOptions("");
    expect(res.status).toBe(401);
  });
});

describe("provisioning helpers", () => {
  it("listPasskeys shows labels and provider without key material", () => {
    const rows = provisioning.listPasskeys("LUCAS");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Test key", provider: "iCloud Keychain", deviceType: "multiDevice", backedUp: true });
    // Signed in with in the first test above.
    expect(rows[0]?.lastUsedAtMs).toEqual(expect.any(Number));
    expect(JSON.stringify(rows)).not.toMatch(/publicKey|credentialID/);
    expect(provisioning.listUsers().find((u) => u.username === "lucas")?.passkeys).toBe(1);
  });

  it("a password reset keeps passkeys", async () => {
    await provisioning.setPassword("lucas", "a-different-long-passphrase");
    expect(provisioning.listPasskeys("lucas")).toHaveLength(1);
  });

  it("removePasskeys deletes only that user's passkeys", () => {
    enrol(userId("lucas"), "Second key");
    expect(provisioning.removePasskeys("lucas")).toBe(2);
    expect(provisioning.listPasskeys("lucas")).toHaveLength(0);
    expect(provisioning.listPasskeys("marja")).toHaveLength(1);
    expect(() => provisioning.removePasskeys("nobody")).toThrow(/no such user/);
  });

  it("the table cascades from user (accounts are never deleted here, but the FK must say so)", () => {
    const fks = handle.sqlite.prepare("PRAGMA foreign_key_list(passkey)").all() as {
      table: string;
      from: string;
      on_delete: string;
    }[];
    expect(fks).toEqual([expect.objectContaining({ table: "user", from: "userId", on_delete: "CASCADE" })]);
  });
});

describe("owner removal", () => {
  it("only an owner can remove a member's passkeys, and the removal is audited", async () => {
    const { bootstrapOwner, deleteMemberPasskeys } = await import("@/server/services/members");
    const { auditLog } = await import("@/db/schema");
    const lucas = userId("lucas");
    const marja = userId("marja");
    writeTx(handle.db, (tx) => bootstrapOwner(tx, "lucas"));
    enrol(lucas, "Owner key");

    expect(() => writeTx(handle.db, (tx) => deleteMemberPasskeys(tx, marja, lucas))).toThrow(/owner/i);
    expect(provisioning.listPasskeys("lucas")).toHaveLength(1);

    const sessionsBefore = sessionCount(marja);
    expect(writeTx(handle.db, (tx) => deleteMemberPasskeys(tx, lucas, marja))).toBe(1);
    expect(provisioning.listPasskeys("marja")).toHaveLength(0);
    // Sessions are a separate decision (password reset / revoke-sessions).
    expect(sessionCount(marja)).toBe(sessionsBefore);
    const audit = handle.db.select().from(auditLog).where(eq(auditLog.action, "passkeys_removed")).all();
    expect(audit).toEqual([expect.objectContaining({ actorUserId: lucas, entityId: marja, summary: "Removed 1 passkey" })]);
  });
});

describe("default names", () => {
  it("prefers the provider, then the registering device, then 'Passkey'", () => {
    expect(passkeyProviderName(ICLOUD_AAGUID.toUpperCase())).toBe("iCloud Keychain");
    expect(passkeyProviderName("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(defaultPasskeyName(ICLOUD_AAGUID, null)).toBe("iCloud Keychain");
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(defaultPasskeyName("00000000-0000-0000-0000-000000000000", iphone)).toBe("Safari on iPhone");
    expect(defaultPasskeyName(undefined, undefined)).toBe("Passkey");
  });
});

describe("challenge rows in verification", () => {
  const authenticationChallenges = () =>
    handle.db
      .select()
      .from(verification)
      .all()
      .filter((row) => (JSON.parse(row.value) as { type?: string }).type === "authentication");

  async function authenticateOptions(): Promise<Response> {
    const res = await web.handler(
      new Request(`${BASE}/api/auth/passkey/generate-authenticate-options`, {
        headers: { origin: BASE, "x-forwarded-for": clientIp() },
      }),
    );
    expect(res.status).toBe(200);
    return res;
  }

  it("every options call (one per login page load) leaves a 5-minute row that only expiry-pruning removes", async () => {
    writeTx(handle.db, (tx) => tx.delete(verification).run());
    await authenticateOptions();
    await authenticateOptions();
    const rows = authenticationChallenges();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(ttl).toBeGreaterThanOrEqual(299_000);
      expect(ttl).toBeLessThanOrEqual(301_000);
    }

    // Nothing is expired yet, so nothing goes.
    expect(provisioning.pruneExpiredVerifications()).toBe(0);
    expect(authenticationChallenges()).toHaveLength(2);
    // Six minutes on, both are dead weight.
    expect(provisioning.pruneExpiredVerifications(Date.now() + 6 * 60_000)).toBe(2);
    expect(handle.db.select().from(verification).all()).toHaveLength(0);
  });

  it("pruning in the middle of a sign-in leaves that sign-in's live challenge alone", async () => {
    writeTx(handle.db, (tx) => tx.delete(verification).run());
    // An abandoned, already-expired challenge next to the live one the sign-in below creates.
    writeTx(handle.db, (tx) =>
      tx
        .insert(verification)
        .values({
          id: crypto.randomUUID(),
          identifier: "abandoned",
          value: JSON.stringify({ type: "authentication", expectedChallenge: "x", userData: { id: "" } }),
          expiresAt: new Date(Date.now() - 1_000),
        })
        .run(),
    );
    const key = enrol(userId("lucas"), "Prune key");
    const pruneBetween = vi.fn(() => provisioning.pruneExpiredVerifications());
    const res = await passkeySignIn(key, pruneBetween);
    expect(pruneBetween).toHaveBeenCalledOnce();
    expect(pruneBetween.mock.results[0]?.value).toBe(1);
    expect(res.status, await res.clone().text()).toBe(200);
    // The sign-in consumed its own row; the abandoned one was pruned.
    expect(handle.db.select().from(verification).all()).toHaveLength(0);
    writeTx(handle.db, (tx) => tx.delete(passkey).where(eq(passkey.name, "Prune key")).run());
  });
});

describe("registration ceremony with Apple's all-zero AAGUID", () => {
  const ZERO_AAGUID = Buffer.alloc(16);
  const IPHONE_SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

  /** CBOR byte-string header for `length` bytes (major type 2). */
  function cborBytesHeader(length: number): Buffer {
    if (length < 24) return Buffer.from([0x40 + length]);
    if (length < 256) return Buffer.from([0x58, length]);
    return Buffer.from([0x59, length >> 8, length & 0xff]);
  }

  /** `{ fmt: "none", attStmt: {}, authData }` — what Safari sends under `attestation: "none"`. */
  function noneAttestation(authData: Buffer): Buffer {
    return Buffer.concat([
      Buffer.from([0xa3, 0x63, ...Buffer.from("fmt"), 0x64, ...Buffer.from("none")]),
      Buffer.from([0x67, ...Buffer.from("attStmt"), 0xa0]),
      Buffer.from([0x68, ...Buffer.from("authData")]),
      cborBytesHeader(authData.length),
      authData,
    ]);
  }

  it("names the passkey after the registering browser, and a sign-in with it stamps lastUsedAt", async () => {
    await provisioning.createUser({ username: "ana", name: "Ana", password: PASSWORD });
    const signedIn = await passwordSignIn("ana", PASSWORD);
    expect(signedIn.status).toBe(200);
    const sessionCookies = cookiesFrom(signedIn);

    const optionsRes = await registerOptions(sessionCookies);
    expect(optionsRes.status, await optionsRes.clone().text()).toBe(200);
    const options = (await optionsRes.json()) as { challenge: string };

    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = coseEs256(Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url"));
    const credentialId = randomBytes(16);
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      createHash("sha256").update(RP_ID).digest(),
      Buffer.from([0x5d]), // UP | UV | backup-eligible | backed-up | attested credential data
      Buffer.alloc(4), // counter 0
      ZERO_AAGUID,
      credentialIdLength,
      credentialId,
      cose,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: BASE, crossOrigin: false }),
    );

    const verified = await web.handler(
      new Request(`${BASE}/api/auth/passkey/verify-registration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE,
          "user-agent": IPHONE_SAFARI,
          cookie: `${sessionCookies}; ${cookiesFrom(optionsRes)}`,
          "x-forwarded-for": clientIp(),
        },
        body: JSON.stringify({
          response: {
            id: b64url(credentialId),
            rawId: b64url(credentialId),
            type: "public-key",
            response: {
              clientDataJSON: b64url(clientDataJSON),
              attestationObject: b64url(noneAttestation(authData)),
              transports: ["internal", "hybrid"],
            },
            clientExtensionResults: {},
          },
        }),
      }),
    );
    expect(verified.status, await verified.clone().text()).toBe(200);

    const ana = userId("ana");
    const stored = handle.db.select().from(passkey).where(eq(passkey.userId, ana)).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      name: "Safari on iPhone",
      aaguid: "00000000-0000-0000-0000-000000000000",
      deviceType: "multiDevice",
      backedUp: true,
      lastUsedAt: null,
    });
    expect(provisioning.listPasskeys("ana")[0]).toMatchObject({ provider: null, lastUsedAtMs: null });

    const signIn = await passkeySignIn({ credentialId, privateKey, counter: 0 });
    expect(signIn.status, await signIn.clone().text()).toBe(200);
    const after = handle.db.select().from(passkey).where(eq(passkey.userId, ana)).get();
    expect(after?.lastUsedAt).toBeInstanceOf(Date);
    expect(provisioning.listPasskeys("ana")[0]?.lastUsedAtMs).toEqual(after!.lastUsedAt!.getTime());
  });
});
