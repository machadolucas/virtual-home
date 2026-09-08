import "server-only";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { user, userNotifyDevice } from "@/db/schema";

export interface NotifyDeviceRow {
  id: string;
  label: string;
  notifyService: string;
  haDeviceName: string | null;
  isActive: boolean;
  createdAtMs: number;
}

export interface HouseholdMember {
  id: string;
  name: string;
  username: string;
  displayColor: string | null;
  createdAtMs: number;
  devices: NotifyDeviceRow[];
}

/**
 * The household members with their notify devices.
 *
 * `@/server/auth/provisioning`'s `listUsers` is the CLI's view (it counts sessions, which needs
 * fresh-session care); this is the settings page's view, which needs devices and nothing about
 * sessions — those live on Settings -> Security.
 */
export function listMembers(tx: Db): HouseholdMember[] {
  const users = tx.select().from(user).orderBy(asc(user.createdAt)).all();
  const devices = new Map<string, NotifyDeviceRow[]>();
  for (const row of tx
    .select()
    .from(userNotifyDevice)
    .orderBy(asc(userNotifyDevice.label))
    .all()) {
    devices.set(row.userId, [
      ...(devices.get(row.userId) ?? []),
      {
        id: row.id,
        label: row.label,
        notifyService: row.notifyService,
        haDeviceName: row.haDeviceName,
        isActive: row.isActive,
        createdAtMs: row.createdAtMs,
      },
    ]);
  }
  return users.map((row) => ({
    id: row.id,
    name: row.name,
    username: row.username ?? row.displayUsername ?? "",
    displayColor: row.displayColor,
    createdAtMs: row.createdAt.getTime(),
    devices: devices.get(row.id) ?? [],
  }));
}

/** Every notify service already registered, so a candidate list can exclude them. */
export function claimedNotifyServices(tx: Db): string[] {
  return tx
    .select({ notifyService: userNotifyDevice.notifyService })
    .from(userNotifyDevice)
    .all()
    .map((row) => row.notifyService);
}

export function readMember(tx: Db, userId: string): HouseholdMember | null {
  return listMembers(tx).find((row) => row.id === userId) ?? null;
}

/** Names for attribution chips elsewhere. */
export function userNames(tx: Db): Map<string, string> {
  return new Map(
    tx
      .select({ id: user.id, name: user.name })
      .from(user)
      .all()
      .map((row) => [row.id, row.name]),
  );
}

export function userExists(tx: Db, userId: string): boolean {
  return tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).get() !== undefined;
}
