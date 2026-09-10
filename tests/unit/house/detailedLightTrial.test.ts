import { afterEach, expect, it, vi } from "vitest";
import { DetailedLightTrial } from "@/house/scene/detailedLightTrial";

afterEach(() => vi.useRealTimers());

it("recovers once after rejected experimental shaders and prevents cached failures on retry", () => {
  vi.useFakeTimers();
  const recover = vi.fn();
  const trial = new DetailedLightTrial(recover);
  expect(trial.configure(8, 8, 12, true)).toBe(true);
  expect(trial.reject()).toBe(true);
  expect(trial.reject()).toBe(true);
  expect(recover).not.toHaveBeenCalled(); // never mutate the scene during compilation
  vi.runAllTimers();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(trial.configure(6, 6, 12, true)).toBe(true);
  expect(trial.configure(8, 8, 12, true)).toBe(false);
  vi.runAllTimers();
  expect(recover).toHaveBeenCalledTimes(2);
  expect(trial.configure(7, 6, 12, true)).toBe(true);
  trial.dispose();
});

it("leaves ordinary shader errors to the renderer and cancels recovery on disposal", () => {
  vi.useFakeTimers();
  const recover = vi.fn();
  const trial = new DetailedLightTrial(recover);
  trial.configure(6, 6, 12, true);
  expect(trial.reject()).toBe(false);
  trial.configure(8, 8, 12, false);
  expect(trial.reject()).toBe(false);
  trial.configure(8, 8, 12, true);
  trial.reject();
  trial.dispose();
  vi.runAllTimers();
  expect(recover).not.toHaveBeenCalled();
});
