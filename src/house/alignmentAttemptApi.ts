import type { AlignmentAttempt } from "./alignmentAttemptTypes";

// A bounded, same-account outbox survives a closed tab or an offline headset.
const queuePrefix = (base: string, userId: string) =>
  `vh:alignment:${encodeURIComponent(userId)}:${encodeURIComponent(base)}:`;
const keyFor = (base: string, report: AlignmentAttempt) => queuePrefix(base, report.userId) + report.id;
const MAX_AGE = 7 * 86_400_000;
const MAX_QUEUED = 5;

function pending(base: string, userId: string) {
  const prefix = queuePrefix(base, userId);
  const entries: {key: string; report: AlignmentAttempt}[] = [];
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      try {
        const report = JSON.parse(localStorage.getItem(key)!) as AlignmentAttempt;
        if (report.userId !== userId || key !== keyFor(base, report) ||
          !Number.isFinite(report.startedAtMs) || Date.now() - report.startedAtMs > MAX_AGE) {
          localStorage.removeItem(key);
        } else entries.push({ key, report });
      } catch { localStorage.removeItem(key); }
    }
  } catch { /* Some browsers disable local storage. Online saves still work. */ }
  return entries.sort((a, b) => b.report.startedAtMs - a.report.startedAtMs);
}

export function queueAlignmentAttempt(base: string, report: AlignmentAttempt): boolean {
  try {
    const key = keyFor(base, report);
    const entries = pending(base, report.userId).filter(entry => entry.key !== key);
    for (const stale of entries.slice(MAX_QUEUED - 1)) localStorage.removeItem(stale.key);
    localStorage.setItem(key, JSON.stringify(report));
    return true;
  } catch { return false; }
}

class UploadError extends Error {
  constructor(readonly status: number) { super("Alignment report upload failed"); }
}
export async function uploadAlignmentAttempt(base: string, report: AlignmentAttempt, closing = false) {
  const body = JSON.stringify(report);
  const response = await fetch(base + "/alignment-attempts", {
    method: "POST", credentials: "same-origin", headers: {"Content-Type":"application/json", "X-VH-Alignment":"1"},
    body, keepalive: closing && new Blob([body]).size < 60 * 1024,
  });
  if (!response.ok) throw new UploadError(response.status);
  const ack = await response.json() as {id: string; revision: number};
  if (ack.id !== report.id || !Number.isSafeInteger(ack.revision) || ack.revision < report.revision)
    throw new Error("Alignment report checkpoint was not acknowledged");
  try {
    const key = keyFor(base, report);
    const stored = localStorage.getItem(key);
    if (stored && JSON.parse(stored).revision <= ack.revision) localStorage.removeItem(key);
  } catch { /* Acknowledged by the household installation. */ }
  return ack.revision;
}

export async function retryAlignmentAttempts(base: string, userId: string) {
  for (const {report} of pending(base, userId).slice(0, MAX_QUEUED)) {
    try { await uploadAlignmentAttempt(base, report); } catch (error) {
      if (!(error instanceof UploadError) || error.status === 401 || error.status >= 500) break;
    }
  }
}
