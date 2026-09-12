"use client";
import type { Route } from "next";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, TriangleAlert } from "lucide-react";
import { Badge, Button, IconButton, Sheet } from "@/ui";
import { acknowledgeAlert } from "@/server/actions/settings/household";
import type { NotificationSnapshot } from "@/server/queries/notifications";

function useNotifications(page: number, includeAcknowledged: boolean, limit: number) {
  const requestKey = `${page}:${includeAcknowledged}:${limit}`;
  const [result, setResult] = useState<{ key: string; data: NotificationSnapshot } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (running || stopped) return;
      running = true;
      try {
        const response = await fetch(`/api/notifications?${new URLSearchParams({ page: String(page), limit: String(limit), includeAcknowledged: includeAcknowledged ? "1" : "0" })}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("unavailable");
        const next = await response.json() as NotificationSnapshot;
        if (!stopped) { setResult({ key: requestKey, data: next }); setFailedKey(null); }
      } catch { if (!stopped) setFailedKey(requestKey); }
      finally { running = false; }
    };
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 1000); };
    void refresh();
    const interval = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30000);
    const source = new EventSource("/api/events");
    source.addEventListener("batch", (event) => {
      try { const frame = JSON.parse((event as MessageEvent).data) as { items?: { topic?: string }[] }; if (frame.items?.some((item) => item.topic && !item.topic.startsWith("ha."))) schedule(); } catch { schedule(); }
    });
    source.addEventListener("open", schedule);
    source.addEventListener("resync", schedule);
    window.addEventListener("focus", schedule);
    window.addEventListener("vh:notifications", schedule);
    return () => { stopped = true; controller.abort(); clearInterval(interval); clearTimeout(timer); source.close(); window.removeEventListener("focus", schedule); window.removeEventListener("vh:notifications", schedule); };
  }, [page, includeAcknowledged, limit, requestKey]);
  return { data: result?.key === requestKey ? result.data : null, error: failedKey === requestKey };
}

export function NotificationBell() {
  const [showSeen, setShowSeen] = useState(false);
  const { data, error } = useNotifications(1, showSeen, 8);
  const [open, setOpen] = useState(false);
  return <>
    <div className="relative"><IconButton label={`Notifications${data && data.unseen + data.pending ? `, ${data.unseen + data.pending} unseen` : ""}${error ? ", unavailable" : ""}`} icon={<Bell />} onClick={() => setOpen(true)} size="sm" />
      {data && data.unseen + data.pending > 0 ? <span className="pointer-events-none absolute -right-1 -top-1 min-w-4 rounded-full bg-overdue px-1 text-center text-[10px] font-semibold text-white">{data.unseen + data.pending > 99 ? "99+" : data.unseen + data.pending}</span> : data?.liveIssue || error ? <span className="pointer-events-none absolute right-0 top-0 size-2 rounded-full bg-due" /> : null}
    </div>
    <Sheet open={open} onOpenChange={setOpen} side="right" title="Notifications" description="Problems that need attention. Seen does not mean resolved." footer={<Link href="/notifications" onClick={() => setOpen(false)}>View all notifications</Link>}>
      <NotificationList data={data} error={error} includeAcknowledged={showSeen} onIncludeChange={setShowSeen} compact onNavigate={() => setOpen(false)} />
    </Sheet>
  </>;
}
export function NotificationsPageContent() {
  const [page, setPage] = useState(1);
  const [showSeen, setShowSeen] = useState(false);
  const { data, error } = useNotifications(page, showSeen, 50);
  return <NotificationList data={data} error={error} includeAcknowledged={showSeen} onIncludeChange={(next) => { setShowSeen(next); setPage(1); }} onPageChange={setPage} />;
}
function NotificationList({ data, error, includeAcknowledged, onIncludeChange, compact = false, onNavigate, onPageChange }: {
  data: NotificationSnapshot | null; error: boolean; includeAcknowledged: boolean;
  onIncludeChange: (value: boolean) => void; compact?: boolean; onNavigate?: () => void;
  onPageChange?: (page: number) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const alerts = data?.alerts ?? [];
  return <div className="space-y-3">
    {error ? <p role="status" className="text-overdue">Could not refresh notifications. Showing the last available information.</p> : !data ? <p role="status">Loading notifications…</p> : null}
    {data && data.pending > 0 ? <Link href="/settings/ai-connections" onClick={onNavigate} className="block rounded-md border border-line bg-accent-soft p-3 font-medium">{data.pending} AI change request{data.pending === 1 ? "" : "s"} to review</Link> : null}
    {data?.liveIssue ? <Link href={(data.liveIssue.href) as Route} onClick={onNavigate} className="flex gap-2 rounded-md border border-line bg-due-soft p-3"><TriangleAlert className="size-5 shrink-0" /><span><strong>{data.liveIssue.title}</strong><span className="mt-1 block text-xs">{data.liveIssue.body}</span></span></Link> : null}
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={includeAcknowledged} onChange={(e) => onIncludeChange(e.target.checked)} />Include acknowledged alerts</label>
    {failure ? <p role="alert" className="text-overdue">{failure}</p> : null}
    {data && !alerts.length ? <p className="text-sm text-ink-3">{includeAcknowledged ? "No unresolved alerts." : "No unseen alerts. Include acknowledged alerts to see ongoing problems you have already seen."}</p> : null}
    <ul className="divide-y divide-line">{alerts.map((alert) => <li key={alert.id} className="space-y-2 py-3">
      <div className="flex items-start gap-2"><Badge tone={alert.severity === "error" ? "overdue" : alert.severity === "warning" ? "due" : "neutral"}>{alert.severity}</Badge><Link href={(alert.href) as Route} onClick={onNavigate} className="font-medium text-ink underline decoration-line underline-offset-4">{alert.title}</Link></div>
      {alert.body ? <p className="whitespace-pre-wrap break-words text-sm text-ink-2">{alert.body}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3"><time dateTime={new Date(alert.lastSeenAtMs).toISOString()}>Last observed {new Date(alert.lastSeenAtMs).toLocaleString()}</time>
        {alert.acknowledgedAtMs !== null ? <span>Seen by {alert.acknowledgedByName ?? "a household member"}</span> : <Button variant="secondary" size="sm" loading={pending === alert.id} onClick={async () => { setPending(alert.id); setFailure(null); try { const result = await acknowledgeAlert({ alertId: alert.id }); if (!result.ok) setFailure(result.error); else window.dispatchEvent(new Event("vh:notifications")); } catch { setFailure("Could not acknowledge this alert. Try again."); } finally { setPending(null); } }}>Mark seen</Button>}
      </div>
    </li>)}</ul>
    {data && !compact && onPageChange && data.total > 0 ? <nav aria-label="Notification pages" className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
      <Button variant="secondary" size="sm" disabled={!data.hasPrevious} onClick={() => onPageChange(data.page - 1)}>Previous</Button>
      <span className="text-xs text-ink-3" aria-live="polite">{(data.page - 1) * data.limit + 1}–{Math.min(data.page * data.limit, data.total)} of {data.total} alerts</span>
      <Button variant="secondary" size="sm" disabled={!data.hasNext} onClick={() => onPageChange(data.page + 1)}>Next</Button>
    </nav> : null}
    {data?.hasNext && compact ? <p className="text-xs text-ink-3">{data.total - data.alerts.length} more in all notifications.</p> : null}
  </div>;
}
