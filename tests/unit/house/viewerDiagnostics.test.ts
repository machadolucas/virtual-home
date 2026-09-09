import { describe, expect, it } from "vitest";
import { FrameRateSampler } from "@/house/components/ViewerDiagnostics";

describe("FrameRateSampler", () => {
  it("reports the rate of a sustained render burst", () => {
    const sampler = new FrameRateSampler();
    const readings: number[] = [];

    for (let atMs = 0; atMs <= 1_000; atMs += 1000 / 60) {
      const reading = sampler.frame(atMs);
      if (reading !== null) readings.push(reading);
    }

    expect(readings).toEqual([60]);
  });

  it("reports sustained slow rendering instead of leaving the counter idle", () => {
    const sampler = new FrameRateSampler();
    for (const time of [0, 500, 1_000]) expect(sampler.frame(time)).toBeNull();
    expect(sampler.frame(1_500)).toBe(2);
  });

  it("does not describe isolated demand frames as low performance", () => {
    const sampler = new FrameRateSampler();

    expect(sampler.frame(0)).toBeNull();
    expect(sampler.frame(700)).toBeNull();
    expect(sampler.frame(1_400)).toBeNull();
  });

  it("starts a fresh sample after the viewer settles", () => {
    const sampler = new FrameRateSampler();

    for (let atMs = 0; atMs <= 500; atMs += 50) sampler.frame(atMs);
    expect(sampler.frame(1_200)).toBeNull();
    expect(sampler.frame(1_250)).toBeNull();
  });
});
