type HapticLevel = "standard" | "light" | "off";
type Cue = "hover" | "aim" | "select" | "land";

const pulses = {
  hover: { strength: 0.24, duration: 16 },
  aim: { strength: 0.36, duration: 22 },
  select: { strength: 0.70, duration: 38 },
  land: { strength: 0.88, duration: 64 },
} as const;

interface Actuator {
  pulse?(strength: number, duration: number): Promise<boolean> | void;
  playEffect?(kind: "dual-rumble", params: GamepadEffectParameters): Promise<unknown> | void;
}
interface HapticPad {
  connected?: boolean;
  hapticActuators?: readonly Actuator[];
  vibrationActuator?: Actuator | null;
}
interface Controller {
  target: string | null;
  entered: number;
  announced: boolean;
  quietUntil: number;
  sequence: number;
}

export class ControllerHaptics {
  level: HapticLevel = "standard";
  private controllers = new WeakMap<XRInputSource, Controller>();

  constructor() {
    try {
      const level = localStorage.getItem("vh.xr.haptics");
      if (level === "off" || level === "light") this.level = level;
    } catch { /* Device storage is optional. */ }
  }

  cycle() {
    this.level = this.level === "standard" ? "light" : this.level === "light" ? "off" : "standard";
    this.reset();
    try { localStorage.setItem("vh.xr.haptics", this.level); } catch { /* optional */ }
  }

  private controller(source: XRInputSource) {
    let state = this.controllers.get(source);
    if (!state) {
      state = { target: null, entered: 0, announced: false, quietUntil: 0, sequence: 0 };
      this.controllers.set(source, state);
    }
    return state;
  }

  hover(source: XRInputSource, target: string | null, now: number) {
    if (this.level === "off" || source.hand || !source.gamepad) return;
    const state = this.controller(source);
    if (state.target !== target) {
      state.target = target;
      state.entered = now;
      state.announced = false;
    }
    if (!target || state.announced || now - state.entered < 45 || now < state.quietUntil) return;
    state.announced = true;
    this.play(source, "hover", now);
  }

  play(source: XRInputSource, cue: Cue, now = performance.now()) {
    const pad: HapticPad | undefined = source.gamepad;
    if (this.level === "off" || source.hand || !pad || pad.connected === false) return;
    const state = this.controller(source);
    const sequence = ++state.sequence;
    state.quietUntil = now + (cue === "hover" ? 90 : 180);
    const { strength, duration } = pulses[cue];
    const magnitude = strength * (this.level === "light" ? 0.55 : 1);
    const current = () => this.controllers.get(source) === state && state.sequence === sequence;
    void this.drive(pad, magnitude, duration, current);
  }

  private async drive(pad: HapticPad, magnitude: number, duration: number, current: () => boolean) {
    // Quest exposes the grip motor at index zero. Other browsers expose a single vibration actuator.
    const grip = pad.hapticActuators?.[0];
    const single = pad.vibrationActuator;
    const motor = typeof grip?.pulse === "function" ? grip : single;
    if (typeof motor?.pulse === "function") {
      try {
        if ((await motor.pulse(magnitude, duration)) !== false) return;
      } catch { /* The browser can expose pulse but reject it on this controller. */ }
    }
    if (!current() || pad.connected === false) return;
    const rumble = typeof single?.playEffect === "function" ? single : grip;
    try {
      await rumble?.playEffect?.("dual-rumble", {
        duration, strongMagnitude: magnitude, weakMagnitude: magnitude,
      });
    } catch { /* Missing or denied haptics must not interrupt the interaction. */ }
  }

  reset() { this.controllers = new WeakMap(); }
}
