/**
 * Turn a raw `User-Agent` string into something a person recognises in a list
 * of signed-in devices. Pure and deliberately shallow: this is a hint for the
 * owner of the session, not device fingerprinting, so a wrong guess costs
 * nothing and the raw string stays available in the UI.
 */
export interface DeviceLabel {
  /** e.g. "Safari on iPhone". Never empty. */
  label: string;
  /** "phone" | "tablet" | "desktop" | "unknown" — chooses the glyph. */
  form: "phone" | "tablet" | "desktop" | "unknown";
}

export function describeDevice(userAgent: string | null | undefined): DeviceLabel {
  const ua = (userAgent ?? "").trim();
  if (ua === "") return { label: "Unknown device", form: "unknown" };

  const platform =
    /iPhone/i.test(ua)
      ? "iPhone"
      : /iPad/i.test(ua)
        ? "iPad"
        : /Android/i.test(ua)
          ? "Android"
          : /Macintosh|Mac OS X/i.test(ua)
            ? "Mac"
            : /Windows/i.test(ua)
              ? "Windows"
              : /Linux/i.test(ua)
                ? "Linux"
                : null;

  // Order matters: Edge and Chrome both claim "Safari", Chrome claims "Edg" never.
  const browser =
    /Edg\//i.test(ua)
      ? "Edge"
      : /OPR\//i.test(ua)
        ? "Opera"
        : /Firefox\//i.test(ua)
          ? "Firefox"
          : /Chrome\//i.test(ua)
            ? "Chrome"
            : /Safari\//i.test(ua)
              ? "Safari"
              : /Home ?Assistant/i.test(ua)
                ? "Home Assistant app"
                : null;

  const form: DeviceLabel["form"] =
    platform === "iPhone" || platform === "Android"
      ? "phone"
      : platform === "iPad"
        ? "tablet"
        : platform === "Mac" || platform === "Windows" || platform === "Linux"
          ? "desktop"
          : "unknown";

  if (browser && platform) return { label: `${browser} on ${platform}`, form };
  if (browser) return { label: browser, form };
  if (platform) return { label: platform, form };
  return { label: "Unknown device", form: "unknown" };
}
