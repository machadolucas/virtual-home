/**
 * Tiny class-name joiner. No `tailwind-merge`, deliberately: it would be a
 * dependency, and this app has two users and one design system.
 *
 * The consequence is worth stating plainly, because it is easy to get wrong:
 * **conflicting utilities are resolved by stylesheet order, not by the order
 * they appear in the class list.** Appending the caller's `className` last does
 * NOT make it win — `p-1.5` after `p-3` still loses, because Tailwind emits
 * `.p-3` later in the sheet.
 *
 * So the primitives here avoid setting a utility a caller is likely to want to
 * change, and expose a prop instead (`Popover`'s `padded`, `Button`'s `size`,
 * `Panel`'s `flush`), or let `className` replace the default outright
 * (`HouseMark`). Layout classes callers do pass — margins, `hidden`, grid
 * placement — do not collide with anything the primitives set.
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[]
  | { [key: string]: boolean | null | undefined };

/** Join truthy class values into a single, whitespace-normalised string. */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  push(values, out);
  return out.join(" ");
}

function push(value: ClassValue, out: string[]): void {
  if (value === null || value === undefined || value === false || value === "") return;
  if (typeof value === "string") {
    for (const part of value.split(/\s+/)) if (part) out.push(part);
    return;
  }
  if (typeof value === "number") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) push(item, out);
    return;
  }
  for (const key of Object.keys(value)) {
    if (value[key]) push(key, out);
  }
}

/**
 * The one and only focus indicator. Always visible (never `outline-none`
 * without a replacement), 2 px, offset so it reads on filled buttons too.
 */
export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Focus ring drawn inside the element — for controls flush against a panel
 * edge (sidebar rows, table headers) where an offset ring would be clipped.
 */
export const focusRingInset =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/** Minimum interactive box: 24 px everywhere, 44 px where a finger is likely. */
export const hitArea = "min-h-6 min-w-6 md:min-h-6";
export const touchArea = "min-h-11 min-w-11 md:min-h-9 md:min-w-9";
