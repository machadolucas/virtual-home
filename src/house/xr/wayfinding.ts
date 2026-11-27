import { Vector3 } from "three";
import type { HouseRuntime } from "../runtime";
import { pointInFootprint, ringBBox } from "../model/geometry2d";
import type { Room, Vec3 } from "../model/types";
import type { FrameArea } from "./frameLog";
import type { WalkWorld } from "./walkWorld";

/** Room IDs belong to the installed model. Use its room names and keep menu order intact. */
export function walkthroughStart(
  rooms: ReadonlyArray<{ room: Room; position: Vec3 }>,
  names: Readonly<Record<string, string>>,
  world: WalkWorld,
  eyeHeight: number,
): Vector3 | null {
  const ranked = rooms.map(({ room, position }) => {
    const labels = [names[room.id], room.name, room.nameFi, ...room.aliases]
      .filter((label): label is string => !!label)
      .map(label => label.trim().toLowerCase().replace(/[-_\s]+/g, " "));
    const rank = labels.some(label => /^(living room|livingroom|olohuone)$/.test(label)) ? 0
      : labels.some(label => /^(lounge|family room|sitting room)$/.test(label)) ? 1
      : room.kind === "closet" ? 3 : 2;
    return { room, position, rank };
  }).sort((a, b) => a.rank - b.rank);

  for (const { room, position, rank } of ranked) {
    const nearCentre = world.landing(new Vector3(...position), eyeHeight, room);
    if (nearCentre) return nearCentre;
    if (rank > 1) continue;
    // A sofa or table can occupy the whole central landing area. Try the rest of the room.
    const { minX, maxX, minZ, maxZ } = ringBBox(room.footprint.outer);
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 7; col++) {
        const x = minX + (maxX - minX) * (col + 0.5) / 7;
        const z = minZ + (maxZ - minZ) * (row + 0.5) / 7;
        const point = world.landingAt(x, z, room.floorElevation, eyeHeight, room);
        if (point) return point;
      }
  }
  return null;
}

export interface WalkPlace {
  id: string;
  name: string;
  floor?: string;
  area: FrameArea;
}

export function walkPlace(runtime: HouseRuntime, feet: Vector3, rooms: ReadonlyArray<{room: Room}>): WalkPlace {
  const room = rooms.find(({room}) => Math.abs(room.floorElevation - feet.y) < 0.6 &&
    pointInFootprint(feet.x, feet.z, room.footprint))?.room;
  if (!room) return {id: "outdoors", name: "Yard", area: "Yard"};
  const manifest = runtime.manifest!;
  const floor = manifest.floors.get(room.floorId);
  const building = manifest.buildings.get(room.buildingId ?? floor?.buildingId ?? "");
  return {id: room.id, name: runtime.store.getState().labelPreferences.names[room.id] ?? room.name,
    floor: floor?.name, area: /garage/i.test(building?.name ?? "") ? "Garage" : "House"};
}

export interface WalkStop {
  feet: Vector3;
  heading: number;
  place: WalkPlace;
}

/** Only completed teleports enter this session's history. Store physical model coordinates. */
export class WalkHistory {
  private stops: WalkStop[] = [];
  get previous() { return this.stops.at(-1); }
  remember(feet: Vector3, heading: number, place: WalkPlace) {
    if (this.previous && this.previous.feet.distanceToSquared(feet) < 0.01 &&
      Math.cos(this.previous.heading - heading) > 0.996) return;
    if (this.stops.length === 8) this.stops.shift();
    this.stops.push({ feet: feet.clone(), heading, place });
  }
  returned(stop: WalkStop) {
    if (this.previous === stop) this.stops.pop();
  }
}

/** Touch-family right B is slot 5. A controller that connects with B down must release it first. */
export class QuestBackButton {
  private source?: XRInputSource;
  private down = false;
  pressed(inputs: XRInputSource[]) {
    const source = inputs.find(input => input.handedness === "right" && !input.hand &&
      input.gamepad?.mapping === "xr-standard" && input.profiles?.some(id =>
        /^(?:oculus-touch|meta-quest-touch)(?:-|$)/.test(id)));
    const down = source?.gamepad?.buttons[5]?.pressed === true;
    const edge = !!source && this.source === source && down && !this.down;
    this.source = source;
    this.down = down;
    return edge;
  }
  reset() { this.source = undefined; this.down = false; }
}
