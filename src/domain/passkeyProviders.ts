/**
 * Default labels for passkeys.
 *
 * An AAGUID names an authenticator *model* (never a device or a person) and arrives only with the
 * registration response. It is the one hint we get about where a passkey lives, so a small map
 * turns the common ones into a name a person recognises in Settings → Security. The map is
 * deliberately short and not authoritative: the community list at
 * github.com/passkeydeveloper/passkey-authenticator-aaguids is the full source, and several
 * platforms report the all-zero AAGUID under `attestation: "none"` (Apple devices usually do),
 * which matches nothing. When the AAGUID says nothing, the registering browser's user agent
 * ("Safari on iPhone") is the fallback, and the user can rename the passkey afterwards.
 *
 * Pure and dependency-free, so the auth config (server) and tests can share it.
 */
import { describeDevice } from "./deviceLabel";

const ANONYMOUS_AAGUID = "00000000-0000-0000-0000-000000000000";

/** Lowercase AAGUID → provider name. */
export const PASSKEY_PROVIDERS: Readonly<Record<string, string>> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

/** Provider name for an AAGUID, or null when it is unknown, empty or the anonymous all-zero value. */
export function passkeyProviderName(aaguid: string | null | undefined): string | null {
  const key = aaguid?.trim().toLowerCase();
  if (!key || key === ANONYMOUS_AAGUID) return null;
  return PASSKEY_PROVIDERS[key] ?? null;
}

/** Longest name we store; `update-passkey` accepts any non-empty string, so the UI caps it too. */
export const PASSKEY_NAME_MAX = 60;

/**
 * The label a new passkey gets when the user did not type one: the provider when the AAGUID is
 * known, else the registering device ("Safari on iPhone"), else plain "Passkey".
 */
export function defaultPasskeyName(
  aaguid: string | null | undefined,
  userAgent: string | null | undefined,
): string {
  const provider = passkeyProviderName(aaguid);
  if (provider) return provider;
  const device = describeDevice(userAgent);
  return device.form === "unknown" && device.label === "Unknown device" ? "Passkey" : device.label;
}
