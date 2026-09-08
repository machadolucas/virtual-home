/**
 * Notify-service names for `user_notify_device`.
 *
 * There is no cached table of Home Assistant *services* — the registry cache keeps identities
 * (areas, floors, devices, entities), not the service registry. So the candidate list on
 * Settings -> Users is **derived**, not discovered: the HA companion app registers its phone as a
 * device on the `mobile_app` platform, and its notify service is `notify.mobile_app_<slug>` where
 * the slug is HA's own slugify of the device name.
 *
 * That derivation is a good guess and a bad promise, which is why the UI labels it as a guess and
 * always allows typing the service name by hand. Getting this wrong is cheap to notice (the send
 * fails and `ha_notify_command.last_error` says so) and expensive to hide.
 */

/** `notify.` + lowercase letters, digits and underscores. HA's own constraint. */
export const NOTIFY_SERVICE_PATTERN = /^notify\.[a-z0-9_]+$/;

export function isNotifyService(value: string): boolean {
  return NOTIFY_SERVICE_PATTERN.test(value);
}

/**
 * HA's `slugify`: lowercase, non-alphanumerics to underscores, collapsed, trimmed.
 *
 * Note what this does *not* do: it does not transliterate. HA slugifies "Marja-Helena's iPhone" to
 * `marja_helena_s_iphone`, and a device named only with non-ASCII characters slugifies to an empty
 * string — in which case we produce no candidate rather than a wrong one.
 */
export function slugifyDeviceName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

/** A device the `mobile_app` integration registered, as the registry cache holds it. */
export interface MobileAppDevice {
  deviceId: string;
  /** `name_by_user` when the household renamed it, else `name`. */
  displayName: string;
  model: string | null;
}

export interface NotifyCandidate {
  /** `notify.mobile_app_lucas_iphone` */
  notifyService: string;
  /** A sensible default label for the device row. */
  label: string;
  /** The HA device name, kept so `user_notify_device.ha_device_name` can match inbound actions. */
  haDeviceName: string;
  deviceId: string;
  model: string | null;
}

/**
 * Derive one candidate per `mobile_app` device, skipping devices whose name slugifies to nothing
 * and de-duplicating on the service name (two devices can slugify identically, and in that case HA
 * itself would have suffixed one — we cannot know which, so we offer the first and let the user
 * correct it by hand).
 */
export function notifyCandidates(devices: readonly MobileAppDevice[]): NotifyCandidate[] {
  const seen = new Set<string>();
  const out: NotifyCandidate[] = [];
  for (const device of devices) {
    const slug = slugifyDeviceName(device.displayName);
    if (slug === "") continue;
    const notifyService = `notify.mobile_app_${slug}`;
    if (seen.has(notifyService)) continue;
    seen.add(notifyService);
    out.push({
      notifyService,
      label: device.displayName,
      haDeviceName: device.displayName,
      deviceId: device.deviceId,
      model: device.model,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Candidates minus the services already registered to somebody. */
export function unclaimedCandidates(
  candidates: readonly NotifyCandidate[],
  claimedServices: readonly string[],
): NotifyCandidate[] {
  const claimed = new Set(claimedServices);
  return candidates.filter((candidate) => !claimed.has(candidate.notifyService));
}
