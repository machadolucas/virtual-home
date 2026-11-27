"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ClipboardList, Upload } from "lucide-react";
import { Button, Dialog } from "@/ui";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";
import {
  captureDesktopModelFix,
  editModelFix,
  getModelFix,
  listModelFixes,
  MODEL_FIX_SAVED_EVENT,
  modelFixImageUrl,
  reopenModelFixView,
  saveModelFix,
  uploadQuestFixScreenshot,
} from "../modelFixApi";
import {
  MAX_MODEL_FIX_SCREENSHOTS,
  modelFixFingerprint,
  type ModelFix, type ModelFixCapture, type ModelFixResolution, type ModelFixStatus, type ModelFixSummary,
  type ModelFixViewScreenshot,
} from "../modelFixTypes";
import { requestEditSwitch } from "./edit/confirmSwitch";
import { OPEN_ROOM_SURVEY } from "../roomSurveyApi";

const source = { desktop: "Desktop", vr: "Virtual reality", mr: "Mixed reality overlay only" } as const;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Could not complete the model fix request.";
}

export function HouseFixes() {
  const runtime = useHouseRuntime();
  const ready = useHouseStore((s) => ["interactive", "enriching", "ready", "degraded"].includes(s.phase));
  const fingerprint = useHouseStore((s) => s.fingerprint);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ModelFixStatus>("pending");
  const [list, setList] = useState<{ items: ModelFixSummary[]; nextCursor: string | null } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [fix, setFix] = useState<ModelFix | null>(null);
  const [description, setDescription] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolutionKind, setResolutionKind] = useState<ModelFixResolution["kind"]>("model_revision");
  const [resolutionText, setResolutionText] = useState("");
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const captureInFlight = useRef(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const retry = useRef<{ requestId: string; capture: ModelFixCapture; fixId?: string } | null>(null);
  const [retryTarget, setRetryTarget] = useState<string | null | undefined>(undefined);
  const { base } = runtime;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void listModelFixes(base, status, undefined, controller.signal).then((page) => {
      if (!controller.signal.aborted) setList(page);
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(errorText(err));
    });
    return () => controller.abort();
  }, [base, open, refresh, status]);

  useEffect(() => {
    function saved(event: Event) {
      const detail = (event as CustomEvent<{ base: string }>).detail;
      if (detail?.base === base) setRefresh((value) => value + 1);
    }
    window.addEventListener(MODEL_FIX_SAVED_EVENT, saved);
    return () => window.removeEventListener(MODEL_FIX_SAVED_EVENT, saved);
  }, [base]);

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const capture = async (fixId?: string, resend = false) => {
    if (captureInFlight.current) return;
    captureInFlight.current = true;
    setCapturing(true);
    setError(null);
    setNotice(null);
    let pending = resend ? retry.current : null;
    try {
      pending ??= { requestId: crypto.randomUUID(), capture: await captureDesktopModelFix(runtime), fixId };
      const stored = await saveModelFix(base, pending.capture, pending.requestId, pending.fixId);
      if (fixId) setFix(stored);
      const message = fixId ? "Screenshot added." : "Model fix captured.";
      setNotice(message);
      runtime.store.getState().announce(message);
      retry.current = null;
      setRetryTarget(undefined);
    } catch (err) {
      setError(errorText(err));
      retry.current = pending;
      setRetryTarget(pending ? pending.fixId ?? null : undefined);
    } finally {
      captureInFlight.current = false;
      setCapturing(false);
    }
  };

  const viewFix = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const record = await getModelFix(base, id);
      setFix(record);
      setDescription(record.description);
      setResolving(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async (nextStatus?: ModelFixStatus, resolution?: ModelFixResolution) => {
    if (!fix) return;
    setBusy(true);
    setError(null);
    try {
      const record = await editModelFix(base, fix.id, {
        expectedUpdatedAtMs: fix.updatedAtMs,
        description,
        status: nextStatus,
        resolution,
      });
      setFix(record);
      setDescription(record.description);
      setResolving(false);
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const attachQuest = async (file: File) => {
    if (!fix) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const record = await uploadQuestFixScreenshot(base, fix.id, file);
      setFix(record);
      setNotice("Quest system screenshot attached.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const loadMore = async () => {
    if (!list?.nextCursor) return;
    setBusy(true);
    setError(null);
    try {
      const page = await listModelFixes(base, status, list.nextCursor);
      setList({ items: [...list.items, ...page.items], nextCursor: page.nextCursor });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const reopen = async (screenshot: ModelFixViewScreenshot) => {
    close();
    // The shared editor prompt remains accessible after the fixes dialog has closed.
    await requestEditSwitch(runtime, async () => {
      try {
        await reopenModelFixView(runtime, screenshot);
        setNotice("Saved viewpoint opened.");
      } catch (err) {
        setError(errorText(err));
      }
    });
  };
  const resolutionInput = resolutionText.trim();
  const resolutionValid = resolutionKind === "model_revision" ? modelFixFingerprint.safeParse(resolutionInput).success : resolutionInput.length > 0;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <Button size="sm" variant="ghost" icon={<Camera className="size-4" />} loading={capturing && !open}
        disabled={!ready || capturing} onClick={() => void capture()}>
        Capture model fix
      </Button>
      <Dialog open={open} onOpenChange={(value) => {
        if (busy || capturing) return;
        if (value) {
          setError(null);
          setNotice(null);
          setOpen(true);
        } else close();
      }} trigger={<Button size="sm" variant="ghost" icon={<ClipboardList className="size-4" />}>Model fixes</Button>}
        title={fix ? "Model fix" : "Model fixes"} size="lg"
        description={fix ? "Review its screenshots, describe the change, and update its status." : "Review captures for this house model."}>
        {error && <p role="alert" className="mb-3 text-overdue">{error}</p>}
        {notice && <p role="status" className="mb-3">{notice}</p>}
        {fix ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" disabled={busy || capturing} onClick={() => { setFix(null); setError(null); }}>All fixes</Button>
              <span className="text-ink-3">{fix.status === "pending" ? "Pending" : "Resolved"}</span>
            </div>
            {fix.surveyObservation && <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2">
              <span>{fix.surveyObservation.kind === "discrepancy" ? "Scan discrepancy with comparison outlines"
                : fix.surveyObservation.kind === "structure" ? "Structural survey observation" : "New object survey observation"}</span>
              <Button size="sm" onClick={() => {
                close();
                window.dispatchEvent(new CustomEvent(OPEN_ROOM_SURVEY, { detail: { id: fix.surveyObservation?.surveyId } }));
              }}>Open room survey</Button>
            </div>}
            <label className="grid gap-1 font-medium text-ink">
              Description
              <textarea className="min-h-24 rounded-md border border-line bg-surface px-3 py-2 font-normal text-ink"
                maxLength={4000} value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy}
                placeholder="What needs to change in the model?" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={busy || capturing || description.trim() === fix.description} onClick={() => void save()}>Save description</Button>
              {fix.status === "pending" ? (
                <Button size="sm" aria-expanded={resolving} disabled={busy || capturing} onClick={() => {
                  setResolutionKind("model_revision");
                  setResolutionText(fingerprint ?? "");
                  setResolving((value) => !value);
                }}>Resolve fix</Button>
              ) : <Button size="sm" disabled={busy || capturing} onClick={() => void save("pending")}>Mark pending</Button>}
              <Button size="sm" loading={capturing} disabled={!ready || busy || capturing || fix.screenshots.length >= MAX_MODEL_FIX_SCREENSHOTS}
                icon={<Camera className="size-4" />} onClick={() => void capture(fix.id, retryTarget === fix.id)}>
                {retryTarget === fix.id ? "Retry screenshot" : "Add current screenshot"}
              </Button>
              <input ref={filePicker} type="file" className="hidden" accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void attachQuest(file);
                }} />
              <Button size="sm" disabled={busy || capturing || fix.screenshots.length >= MAX_MODEL_FIX_SCREENSHOTS}
                icon={<Upload className="size-4" />} onClick={() => filePicker.current?.click()}>
                Attach Quest system screenshot
              </Button>
            </div>
            {resolving && <div className="grid gap-3 rounded-lg border border-line p-3">
              <label className="grid gap-1 font-medium text-ink">
                Resolution reference
                <select value={resolutionKind} onChange={(event) => {
                  const next = event.target.value === "route_change" ? "route_change" : "model_revision";
                  setResolutionKind(next);
                  setResolutionText(next === "model_revision" ? fingerprint ?? "" : "");
                }} className="rounded-md border border-line bg-surface px-2 py-1 font-normal">
                  <option value="model_revision">Model revision fingerprint</option>
                  <option value="route_change">Route change or route ID</option>
                </select>
              </label>
              <label className="grid gap-1 font-medium text-ink">
                {resolutionKind === "model_revision" ? "Fingerprint" : "Route change or route ID"}
                <input value={resolutionText} maxLength={resolutionKind === "model_revision" ? 64 : 1000}
                  onChange={(event) => setResolutionText(event.target.value)}
                  className="rounded-md border border-line bg-surface px-2 py-1 font-normal" />
              </label>
              <Button size="sm" variant="primary" className="w-fit" disabled={busy || capturing || !resolutionValid}
                onClick={() => void save("resolved", resolutionKind === "model_revision"
                  ? { kind: resolutionKind, fingerprint: resolutionInput }
                  : { kind: resolutionKind, note: resolutionInput })}>Mark resolved</Button>
            </div>}
            {fix.resolution && <div className="rounded-md bg-surface-2 px-3 py-2">
              <p className="font-medium text-ink">{fix.resolution.kind === "model_revision" ? "Resolved in model revision" : "Route change reference"}</p>
              <p className="break-all">{fix.resolution.kind === "model_revision" ? fix.resolution.fingerprint : fix.resolution.note}</p>
            </div>}
            {fix.screenshots.map((screenshot) => {
              const viewer = screenshot.content === "quest_system_screenshot" ? null : screenshot;
              const sameRevision = viewer?.fingerprint === fingerprint;
              const title = viewer ? source[viewer.viewpoint.mode] : "Quest system screenshot";
              const overlay = viewer?.viewpoint.overlay;
              const mark = viewer?.viewpoint.routeMeasurement;
              return (
                <section key={screenshot.id} className="rounded-lg border border-line p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-medium text-ink">{title}</h3>
                      {overlay && <p className="text-xs text-ink-3">{overlay === "both" ? "Pipes and ducts" : overlay === "pipes" ? "Pipes" : "Ducts"}</p>}
                      <time className="text-xs text-ink-3" dateTime={new Date(screenshot.capturedAtMs).toISOString()}>{new Date(screenshot.capturedAtMs).toLocaleString()}</time>
                    </div>
                    {viewer && <Button size="sm" disabled={!sameRevision || !ready || busy || capturing} onClick={() => void reopen(viewer)}>
                      Open saved view
                    </Button>}
                  </div>
                  {viewer && !sameRevision && <p className="mb-2 text-xs text-ink-3">Captured on an earlier model revision.</p>}
                  {mark && <div className="mb-3 rounded-md bg-surface-2 p-3 text-sm">
                    <p className="font-medium text-ink">Measured route position</p>
                    <p>{mark.position.map((v, i) => `${["X", "Y", "Z"][i]} ${v.toFixed(3)} m`).join(" · ")}</p>
                    <p className="text-xs text-ink-3">{mark.method === "two_aims" ? "Two controller aims" : "Tracked surface"} · Room alignment check {(mark.registrationErrorM * 100).toFixed(1)} cm</p>
                  </div>}
                  <div className={screenshot.imageCount === 2 ? "grid grid-cols-2 gap-2" : ""}>
                    {Array.from({ length: screenshot.imageCount }, (_, i) => {
                      const url = modelFixImageUrl(base, fix.id, screenshot, i);
                      const alt = `${viewer ? `${title} screenshot` : title}${screenshot.imageCount === 2 ? (i === 0 ? ", left eye" : ", right eye") : ""}`;
                      return <a key={url} href={url} target="_blank" rel="noreferrer" aria-label={`Open ${alt}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated same-origin image bytes */}
                        <img src={url} alt={alt} loading="lazy" className="w-full max-h-80 rounded object-contain bg-surface-3" />
                      </a>;
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex gap-2" aria-label="Fix status">
              {(["pending", "resolved"] as const).map((filter) => (
                <Button key={filter} size="sm" variant={status === filter ? "primary" : "secondary"} aria-pressed={status === filter}
                  disabled={busy || status === filter} onClick={() => { setStatus(filter); setList(null); }}>
                  {filter === "pending" ? "Pending" : "Resolved"}
                </Button>
              ))}
            </div>
            {list === null ? <p role="status">Loading…</p>
              : list.items.length === 0 ? <p>No {status} model fixes.</p>
                : <ul className="grid gap-2">{list.items.map((item) => (
                  <li key={item.id}>
                    <button type="button" disabled={busy} onClick={() => void viewFix(item.id)}
                      className="grid w-full gap-1 rounded-md border border-line bg-surface px-3 py-2 text-left hover:bg-surface-3">
                      <span className="line-clamp-2 font-medium text-ink">{item.description || "Description needed"}</span>
                      <span className="text-xs text-ink-3">{source[item.mode]} · {new Date(item.createdAtMs).toLocaleString()}</span>
                    </button>
                  </li>
                ))}</ul>}
            {list?.nextCursor && <Button size="sm" disabled={busy} onClick={() => void loadMore()}>Load more</Button>}
          </div>
        )}
      </Dialog>
      {!open && error && <p role="alert" className="max-w-56 text-xs text-overdue">{error}</p>}
      {!open && retryTarget === null && <Button size="sm" variant="ghost" disabled={capturing} onClick={() => void capture(undefined, true)}>Retry capture</Button>}
      {!open && notice && <p role="status" className="text-xs text-ink-2">{notice}</p>}
    </div>
  );
}
