/**
 * Passkeys end to end: register one in Settings → Security, sign out, sign back in with the
 * "Sign in with passkey" button, rename it, delete it.
 *
 * The authenticator is Chromium's CDP virtual authenticator (a platform authenticator with
 * resident keys and user verification that always succeeds), so this runs on the Chromium
 * projects only — WebKit has no equivalent. Everything else is real: the production build, the
 * `@better-auth/passkey` endpoints, the signed challenge cookie and the WebAuthn verification.
 *
 * The harness serves the app on `http://localhost:3011` because the RP ID is the base URL's
 * hostname and an IP address is not a valid RP ID.
 */
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { login, openContext } from "./fixtures";

test.describe.configure({ mode: "serial" });

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== "chromium", "The CDP virtual authenticator exists only in Chromium.");
});

/** `WebAuthn.Credential` from the Chrome DevTools Protocol (the fields this spec moves around). */
interface Credential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

async function addVirtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

async function credentials(cdp: CDPSession, authenticatorId: string): Promise<Credential[]> {
  const result = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  return result.credentials as Credential[];
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account: / }).first().click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
}

test("register a passkey, sign in with it, rename it and delete it", async ({ browser }) => {
  // Context A: the device the passkey is created on.
  const first: BrowserContext = await openContext(browser);
  // Context B: a signed-out browser holding the same credential, for the explicit button. Its
  // conditional UI is switched off, because Chromium's virtual authenticator answers a
  // conditional request on its own (context A relies on exactly that) and would sign in before
  // the button could be pressed.
  const second: BrowserContext = await openContext(browser);
  await second.addInitScript(() => {
    if (typeof window.PublicKeyCredential !== "undefined") {
      window.PublicKeyCredential.isConditionalMediationAvailable = async () => false;
    }
  });
  try {
    const page = await first.newPage();
    const a = await addVirtualAuthenticator(page);

    // WebAuthn is allowed for this origin; the rest of the policy is unchanged.
    const loginResponse = await page.goto("/login");
    const policy = loginResponse?.headers()["permissions-policy"] ?? "";
    expect(policy).toContain("publickey-credentials-get=(self)");
    expect(policy).toContain("publickey-credentials-create=(self)");
    expect(policy).toContain("camera=()");

    // Password sign-in first: registration needs a session.
    await login(page, "marja");
    await page.goto("/settings/security");
    const panel = page.locator("section", { has: page.getByRole("heading", { name: "Passkeys" }) });
    await expect(panel.getByText("No passkeys yet")).toBeVisible();

    await panel.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByText("Passkey added")).toBeVisible();
    const list = page.getByRole("list", { name: "Your passkeys" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    // Named by the server from the registering browser (the virtual authenticator's AAGUID is in
    // no provider map), e.g. "Chrome on Mac", or "Safari on iPhone" under the phone project's UA.
    await expect(list.getByRole("listitem").first()).toContainText(/ on |Passkey/);
    await expect(list.getByRole("listitem").first()).toContainText("no sign-in recorded yet");

    // Signing out lands on /login, where conditional UI offers the passkey and the virtual
    // authenticator accepts it: the user is signed straight back in.
    await signOut(page);
    await page.waitForURL((url) => url.pathname === "/today", { timeout: 20_000 });

    // Copy the credential only now: its signature counter has moved on with that sign-in, and the
    // server refuses an assertion whose counter does not exceed the stored one (clone detection).
    const [credential] = await credentials(a.cdp, a.authenticatorId);
    expect(credential?.isResidentCredential).toBe(true);
    expect(credential?.rpId).toBe("localhost");

    // The explicit button, from a browser with no session at all.
    const other = await second.newPage();
    const b = await addVirtualAuthenticator(other);
    await b.cdp.send("WebAuthn.addCredential", { authenticatorId: b.authenticatorId, credential: credential! });
    await other.goto("/login");
    await other.getByRole("button", { name: "Sign in with passkey" }).click();
    await other.waitForURL((url) => url.pathname === "/today", { timeout: 20_000 });

    // Rename.
    await other.goto("/settings/security");
    const item = other.getByRole("list", { name: "Your passkeys" }).getByRole("listitem").first();
    // Both passkey sign-ins above are recorded as uses.
    await expect(item).toContainText("last used");
    await item.getByRole("button", { name: /^Rename / }).click();
    await item.getByRole("textbox", { name: /^New name for / }).fill("E2E test key");
    await item.getByRole("button", { name: "Save" }).click();
    await expect(other.getByText("Passkey renamed")).toBeVisible();
    await expect(item).toContainText("E2E test key");

    // Delete, behind the confirmation.
    await item.getByRole("button", { name: "Delete E2E test key" }).click();
    await other.getByRole("dialog").getByRole("button", { name: "Delete passkey" }).click();
    await expect(other.getByText("Passkey deleted")).toBeVisible();
    await expect(other.getByText("No passkeys yet")).toBeVisible();

    // The server no longer knows the credential, so the authenticator's copy is refused.
    await signOut(other);
    await other.waitForURL((url) => url.pathname === "/login");
    await other.getByRole("button", { name: "Sign in with passkey" }).click();
    await expect(other.locator("#vh-login-error")).toContainText("That passkey was not accepted");
    await expect(other).toHaveURL(/\/login/);
  } finally {
    await first.close();
    await second.close();
  }
});
