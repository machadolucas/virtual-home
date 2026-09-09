"use client";

import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";

const ACTIVE_GAP_MS = 650;
const SAMPLE_WINDOW_MS = 500;
const MIN_ACTIVE_FRAMES = 4;
const IDLE_AFTER_MS = 650;

const IDLE_TITLE =
  "Viewer is idle. Demand rendering has stopped because the camera and scene are settled.";

function markIdleWhenSettled(
  outputRef: RefObject<HTMLOutputElement | null>,
  idleTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  lastFrameAtRef: MutableRefObject<number | null>,
): void {
  const output = outputRef.current;
  const lastFrameAtMs = lastFrameAtRef.current;
  if (!output || lastFrameAtMs === null) {
    idleTimerRef.current = null;
    return;
  }

  const remainingMs = IDLE_AFTER_MS - (performance.now() - lastFrameAtMs);
  if (remainingMs > 0) {
    idleTimerRef.current = setTimeout(
      () => markIdleWhenSettled(outputRef, idleTimerRef, lastFrameAtRef),
      Math.max(1, remainingMs),
    );
    return;
  }

  output.textContent = "idle";
  output.dataset.state = "idle";
  output.title = IDLE_TITLE;
  idleTimerRef.current = null;
}

/**
 * Counts only callbacks from R3F's render loop. A gap starts a new burst, so a few isolated demand
 * frames never appear as a misleading low frame rate.
 */
export class FrameRateSampler {
  private burstStartedAtMs: number | null = null;
  private lastFrameAtMs: number | null = null;
  private frameCount = 0;

  frame(nowMs: number): number | null {
    if (
      this.lastFrameAtMs === null ||
      nowMs - this.lastFrameAtMs > ACTIVE_GAP_MS ||
      this.burstStartedAtMs === null
    ) {
      this.burstStartedAtMs = nowMs;
      this.lastFrameAtMs = nowMs;
      this.frameCount = 1;
      return null;
    }

    this.lastFrameAtMs = nowMs;
    this.frameCount += 1;
    const elapsedMs = nowMs - this.burstStartedAtMs;
    if (elapsedMs < SAMPLE_WINDOW_MS || this.frameCount < MIN_ACTIVE_FRAMES) return null;

    // N samples contain N-1 frame intervals. Reset at this sample so the next reading describes
    // the next window instead of becoming a lifetime average.
    const fps = ((this.frameCount - 1) * 1000) / elapsedMs;
    this.burstStartedAtMs = nowMs;
    this.frameCount = 1;
    return Math.max(1, Math.round(fps));
  }
}

/** Lives inside `<Canvas>` and observes frames without ever requesting one. DOM writes are
 * throttled to the sample window; no React state changes on the render path. */
export function ViewerFrameObserver({
  outputRef,
}: {
  outputRef: RefObject<HTMLOutputElement | null>;
}) {
  const samplerRef = useRef(new FrameRateSampler());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  useFrame(() => {
    const output = outputRef.current;
    if (!output) return;

    const nowMs = performance.now();
    lastFrameAtRef.current = nowMs;
    const fps = samplerRef.current.frame(nowMs);
    if (fps !== null) {
      output.textContent = `${fps} FPS`;
      output.dataset.state = "active";
      output.title = `Viewer rendering at ${fps} frames per second while the camera or scene is moving.`;
    }

    // Keep at most one timer pending. During a long render burst it wakes only once per idle
    // threshold, checks the latest frame time and goes back to sleep without touching the canvas.
    idleTimerRef.current ??= setTimeout(
      () => markIdleWhenSettled(outputRef, idleTimerRef, lastFrameAtRef),
      IDLE_AFTER_MS,
    );
  });

  useEffect(
    () => () => {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      lastFrameAtRef.current = null;
    },
    [],
  );

  return null;
}

/** A quiet DOM sibling of the canvas. It stays readable over custom backgrounds and cannot
 * intercept orbit, placement or selection gestures. */
export function ViewerDiagnostics({
  outputRef,
}: {
  outputRef: RefObject<HTMLOutputElement | null>;
}) {
  return (
    <output
      ref={outputRef}
      data-testid="viewer-frame-rate"
      data-state="idle"
      aria-label="3D viewer rendering activity"
      aria-live="off"
      title={IDLE_TITLE}
      className="pointer-events-none absolute bottom-2 right-2 z-10 min-w-9 rounded-sm border border-line bg-surface/75 px-1.5 py-0.5 text-center font-mono text-[10px] leading-4 text-ink-3 tabular-nums backdrop-blur-sm"
    >
      idle
    </output>
  );
}
