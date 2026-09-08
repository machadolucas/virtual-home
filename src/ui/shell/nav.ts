import {
  Activity,
  Boxes,
  Building2,
  CalendarCheck,
  House,
  Package,
  Plug,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** One line describing the section, used in tooltips and empty states. */
  blurb: string;
  /** Short label for the phone tab bar (must fit ~7 characters). */
  short?: string;
  /** Extra route prefixes this section owns (they highlight it) without being listed. */
  owns?: readonly string[];
  /** Sub-links shown under the section in the sidebar while it is active. */
  children?: readonly { href: string; label: string }[];
}

/**
 * The four sections. This order is the app's spine and is identical on the
 * sidebar and the phone tab bar, so muscle memory transfers between them.
 */
export const MAIN_NAV: readonly NavItem[] = [
  {
    href: "/today",
    label: "Today",
    icon: CalendarCheck,
    blurb: "What needs doing now, and what you finished recently.",
    owns: ["/tasks", "/plans", "/procedures"],
    children: [
      { href: "/plans", label: "Plans" },
      { href: "/procedures", label: "Procedures" },
    ],
  },
  {
    href: "/house",
    label: "House",
    icon: House,
    blurb: "The 3D house: rooms, surfaces, equipment and their history.",
    owns: ["/equipment", "/projects"],
    children: [
      { href: "/equipment", label: "Equipment" },
      { href: "/projects", label: "Projects" },
    ],
  },
  {
    href: "/supplies",
    label: "Supplies",
    icon: Package,
    blurb: "Filters, bulbs, salt and paint — what is in stock and what to buy.",
    children: [{ href: "/supplies/shopping", label: "Shopping list" }],
  },
  {
    href: "/history",
    label: "History",
    icon: ScrollText,
    blurb: "Everything that was actually done, with who, when and proof.",
  },
];

export const SETTINGS_HREF = "/settings";

export interface SettingsNavItem extends NavItem {
  /** Grouping in the settings sub-navigation. */
  group: "account" | "household" | "system";
}

/** Settings sub-navigation. `/settings` itself is the index of these. */
export const SETTINGS_NAV: readonly SettingsNavItem[] = [
  {
    href: "/settings/security",
    label: "Security",
    icon: ShieldCheck,
    group: "account",
    blurb: "Your password and the devices signed in to this household.",
  },
  {
    href: "/settings/household",
    label: "Household",
    icon: Building2,
    group: "household",
    blurb: "Time zone, reminder delivery time and quiet hours.",
  },
  {
    href: "/settings/users",
    label: "Users",
    icon: Users,
    group: "household",
    blurb: "The people in this household and their display colours.",
  },
  {
    href: "/settings/home-assistant",
    label: "Home Assistant",
    icon: Plug,
    group: "system",
    blurb: "The link to Home Assistant and the entities bound to equipment.",
  },
  {
    href: "/settings/model",
    label: "House model",
    icon: Boxes,
    group: "system",
    blurb: "The imported house model package and its semantic identifiers.",
  },
  {
    href: "/settings/system",
    label: "System",
    icon: Activity,
    group: "system",
    blurb: "Worker health, backups, logs and storage.",
  },
];

/**
 * Which nav item owns a pathname. `/settings/...` belongs to Settings;
 * `/house/room/kitchen` belongs to House. Longest matching prefix wins.
 */
export function isActive(href: string, pathname: string): boolean {
  if (href === pathname) return true;
  return pathname.startsWith(`${href}/`);
}

/** A section is active for its own routes and for the routes it owns (e.g. Today owns /tasks). */
export function sectionActive(item: NavItem, pathname: string): boolean {
  if (isActive(item.href, pathname)) return true;
  return (item.owns ?? []).some((prefix) => isActive(prefix, pathname));
}

/** The label for the current route, for `<title>`-like affordances. */
export function activeSectionLabel(pathname: string): string {
  if (isActive(SETTINGS_HREF, pathname)) {
    const sub = SETTINGS_NAV.find((item) => isActive(item.href, pathname));
    return sub ? `Settings · ${sub.label}` : "Settings";
  }
  return MAIN_NAV.find((item) => sectionActive(item, pathname))?.label ?? "virtual-home";
}
