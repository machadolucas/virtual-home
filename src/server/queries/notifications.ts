import "server-only";
import { and, count, isNull, eq, gt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpRequest, mcpConnection } from "@/db/schema/mcp";
import { appAlert } from "@/db/schema/inventory";
import { readAlerts } from "./settings/system";
import { loadMaintenanceHealth } from "./maintenance/status";

export function alertHref(alert: { kind: string; entityTable?: string | null; entityId?: string | null }): string {
  const routes: Record<string, string> = { asset: "/equipment/", part: "/supplies/", maintenance_occurrence: "/tasks/", maintenance_plan: "/plans/", project: "/projects/" };
  if (alert.entityTable && alert.entityId && routes[alert.entityTable]) return routes[alert.entityTable] + encodeURIComponent(alert.entityId);
  if (alert.kind === "integrity") return "/settings/system/integrity";
  if (alert.kind === "model_reconciliation") return "/settings/model";
  if (alert.kind.startsWith("ha_") || alert.kind === "stale_sensor") return "/settings/home-assistant";
  if (alert.kind === "notify_device_missing") return "/settings/users";
  return "/settings/system";
}

export interface NotificationPageOptions {
  /** Bell uses eight; the full page uses fifty. */
  limit?: number;
  page?: number;
  includeAcknowledged?: boolean;
}

export function notificationSnapshot(options: NotificationPageOptions = {}) {
  const db = getDb().db;
  const nowMs = Date.now();
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 50)));
  const includeAcknowledged = options.includeAcknowledged ?? false;
  const filter = and(isNull(appAlert.resolvedAtMs), includeAcknowledged ? undefined : isNull(appAlert.acknowledgedAtMs));
  const total = db.select({ n: count() }).from(appAlert).where(filter).get()?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.max(1, Math.min(pages, Math.trunc(options.page ?? 1)));
  // Apply unseen filtering before the limit, so old unseen alerts cannot disappear behind newer seen ones.
  const alerts = readAlerts(db, limit, { offset: (page - 1) * limit, unseenOnly: !includeAcknowledged }).map((row) => ({ ...row, href: alertHref(row) }));
  const health = loadMaintenanceHealth(db, nowMs);
  const liveIssue = health.kind === "ok" ? null : { title: health.title, body: health.consequence ?? health.detail, href: "/settings/system" };
  const unseen = db.select({ n: count() }).from(appAlert).where(and(isNull(appAlert.resolvedAtMs), isNull(appAlert.acknowledgedAtMs))).get()?.n ?? 0;
  // Household members are peers. Match the review page by counting every active connection's requests.
  const pending = db.select({ n: count() }).from(mcpRequest).innerJoin(mcpConnection, eq(mcpRequest.connectionId, mcpConnection.id)).where(and(isNull(mcpConnection.revokedAtMs), gt(mcpConnection.expiresAtMs, nowMs), eq(mcpRequest.state, "pending"), gt(mcpRequest.expiresAtMs, nowMs))).get()?.n ?? 0;
  return { alerts, unseen, pending, liveIssue, nowMs, total, page, pages, limit, includeAcknowledged, hasPrevious: page > 1, hasNext: page < pages };
}
export type NotificationSnapshot = ReturnType<typeof notificationSnapshot>;
