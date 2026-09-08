"use client";

import { Avatar as RadixAvatar } from "radix-ui";
import { cn } from "./cn";

/**
 * Fallback display colours, used when a user row has no `displayColor` yet.
 * Muted, architectural hues — picked deterministically from the name so the
 * same person is always the same colour without storing anything.
 */
const FALLBACK_COLORS = [
  "#2f5fd0", // accent blue
  "#1f7a4d", // green
  "#8a5a00", // ochre
  "#6b46b8", // violet
  "#b2301c", // brick
  "#4f6473", // slate
] as const;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Cheap, stable string hash (FNV-1a, 32-bit). */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Resolve a display colour. `stored` comes from the database and is therefore
 * validated here — an arbitrary string must never reach a CSS declaration.
 */
export function avatarColor(name: string, stored?: string | null): string {
  if (stored && HEX.test(stored)) return stored;
  const index = hash(name.toLowerCase()) % FALLBACK_COLORS.length;
  return FALLBACK_COLORS[index] ?? FALLBACK_COLORS[0];
}

/** First letters of the first two words, upper-cased. "Marja K" -> "MK". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE: Record<AvatarSize, string> = {
  xs: "size-5 text-[0.625rem]",
  sm: "size-7 text-xs",
  md: "size-9 text-sm",
  lg: "size-12 text-base",
  xl: "size-20 text-2xl",
};

export interface AvatarProps {
  name: string;
  /** `user.displayColor`; ignored unless it is a valid hex colour. */
  color?: string | null;
  /** Optional photo. Falls back to initials while loading or on error. */
  src?: string | null;
  size?: AvatarSize;
  /**
   * By default the avatar is decorative (the name is next to it). Set this when
   * the avatar stands alone.
   */
  labelled?: boolean;
  className?: string;
}

/**
 * Initials on a tint of the person's display colour.
 *
 * The colour is used at ~20 % over the panel surface with ink-coloured text,
 * so contrast does not depend on which hue is stored — an arbitrary user
 * colour can never make the initials unreadable, in either mode.
 */
export function Avatar({
  name,
  color,
  src,
  size = "md",
  labelled = false,
  className,
}: AvatarProps) {
  const hex = avatarColor(name, color);
  return (
    <RadixAvatar.Root
      aria-hidden={labelled ? undefined : true}
      aria-label={labelled ? name : undefined}
      role={labelled ? "img" : undefined}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden",
        "rounded-full font-semibold text-ink",
        SIZE[size],
        className,
      )}
      style={{
        backgroundColor: `color-mix(in srgb, ${hex} 20%, var(--vh-paper-1))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${hex} 55%, transparent)`,
      }}
    >
      {src ? (
        <RadixAvatar.Image src={src} alt="" className="size-full object-cover" />
      ) : null}
      <RadixAvatar.Fallback delayMs={src ? 300 : 0} className="leading-none tracking-tight">
        {initials(name)}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  );
}
