import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerHaptics } from "@/house/xr/haptics";

function controller(gamepad: object): XRInputSource {
  return { gamepad, targetRayMode: "tracked-pointer" } as XRInputSource;
}

afterEach(() => vi.unstubAllGlobals());

describe("controller haptics", () => {
  it("ticks a stable hover once per target on the pointing hand, and gives actions priority over hover", () => {
    const haptics = new ControllerHaptics();
    const pulse = vi.fn(), rightPulse = vi.fn();
    const left = controller({ hapticActuators: [{ pulse }] });
    const right = controller({ hapticActuators: [{ pulse: rightPulse }] });
    haptics.hover(left, "menu/one", 0);
    haptics.hover(left, "menu/two", 30);
    haptics.hover(left, "menu/two", 78);
    haptics.hover(left, "menu/two", 900);
    expect(pulse).toHaveBeenCalledExactlyOnceWith(0.24, 16);
    haptics.play(left, "select", 910);
    haptics.hover(left, "menu/three", 920);
    haptics.hover(left, "menu/three", 1000);
    expect(pulse.mock.calls).toEqual([[0.24, 16], [0.70, 38]]);
    haptics.play(right, "land", 1000);
    expect(rightPulse).toHaveBeenCalledExactlyOnceWith(0.88, 64);
  });

  it("plays via the available actuator when pulse is absent, rejects, declines or throws", async () => {
    for (const pulse of [
      undefined,
      () => { throw new Error("unavailable"); },
      async () => { throw new Error("unavailable"); },
      async () => false,
    ]) {
      const playEffect = vi.fn(async () => "complete");
      const source = controller({ hapticActuators: [{ pulse }], vibrationActuator: { playEffect } });
      new ControllerHaptics().play(source, "select");
      await Promise.resolve();
      expect(playEffect).toHaveBeenCalledExactlyOnceWith("dual-rumble", {
        duration: 38, weakMagnitude: 0.7, strongMagnitude: 0.7,
      });
    }
    const solo = vi.fn();
    new ControllerHaptics().play(controller({ vibrationActuator: { pulse: solo } }), "select");
    expect(solo).toHaveBeenCalledOnce();
  });

  it("drops a delayed fallback if input is reset or a newer cue has replaced it", async () => {
    for (const reset of [true, false]) {
      let reject!: () => void;
      const pulse = vi.fn().mockReturnValueOnce(new Promise((_, fail) => { reject = fail; })).mockResolvedValue(true);
      const playEffect = vi.fn();
      const source = controller({ hapticActuators: [{ pulse }], vibrationActuator: { playEffect } });
      const haptics = new ControllerHaptics();
      haptics.play(source, "aim");
      if (reset) haptics.reset();
      else haptics.play(source, "land");
      reject();
      await Promise.resolve();
      expect(playEffect).not.toHaveBeenCalled();
    }
  });

  it("remembers intensity across sessions and tolerates hand tracking, disconnection and missing motors", () => {
    const prefs = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => prefs.get(key), setItem: (key: string, value: string) => prefs.set(key, value) });
    const pulse = vi.fn();
    const pad = { hapticActuators: [{ pulse }] };
    const source = controller(pad);
    const haptics = new ControllerHaptics();
    haptics.cycle();
    new ControllerHaptics().play(source, "select");
    expect(pulse.mock.calls[0]![0]).toBeCloseTo(0.7 * 0.55);
    haptics.cycle();
    new ControllerHaptics().play(source, "land");
    haptics.cycle();
    haptics.play(controller({ ...pad, connected: false }), "land");
    haptics.play({ ...source, hand: {} } as XRInputSource, "land");
    haptics.play(controller({}), "land");
    expect(pulse).toHaveBeenCalledTimes(1);
  });
});
