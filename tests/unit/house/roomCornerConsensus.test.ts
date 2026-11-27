import { Matrix4, Vector3 } from "three";
import { expect, it } from "vitest";
import type { Room, Vec2 } from "@/house/model/types";
import { calibrationFeatures } from "@/house/xr/mixedCalibration";
import {
  buildAlignmentModel, matchRoomAlignment, matchSelectedRoomCorners, roomPoseDrift,
  type AlignmentLandmark, type AlignmentWall, type RoomEvidence,
} from "@/house/xr/roomAlignment";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = loadManifest(FIXTURE_DIR);
const room: Room = {
  ...manifest.rooms[0]!, floorElevation: 2.8, ceilingHeight: 2.65,
  footprint: { outer: [[0,0],[5.2,0],[5.2,2.4],[6.8,2.4],[6.8,4.3],[5.9,5.25],[0,5.25]], holes: [] },
};
const model = buildAlignmentModel(room, calibrationFeatures({ ...manifest, rooms:[room] },room.floorId,room.id));
const mark = (x: number, z: number, axis: Vec2): AlignmentLandmark => ({
  kind:"window",width:1.15,height:1.45,axis,center:[x,4.2,z],rawCenter:[x,4.2,z],
});
model.landmarks = [mark(1.4,0,[1,0]),mark(0,3.2,[0,1])];
const pose = new Matrix4().makeRotationY(0.62).setPosition(2,-2.83,-1);
const track = ([x,z]: Vec2): Vec2 => {
  const p = new Vector3(x,0,z).applyMatrix4(pose);
  return [p.x,p.z];
};
const eye = new Vector3(1.2,4.4,2).applyMatrix4(pose);
function face(a:Vec2,b:Vec2,offset=0): AlignmentWall {
  return { a:track(a), b:track(b), low:-0.03+offset, high:2.59+offset, semanticWall:true };
}
function scan(extra: AlignmentWall[] = []): RoomEvidence {
  return {
    walls:[face([0,0],[5.2,0]),face([0,0],[0,5.25]),face([5.2,0],[5.2,2.35]),face([0,5.25],[3.9,5.25]),...extra],
    floor:{source:"plane",semanticFloor:true,y:-0.03,outline:[[0,0],[6.8,0],[6.8,5.25],[0,5.25]].map(p=>track(p as Vec2))},
    landmarks:model.landmarks.map(m => {
      const p=new Vector3(...m.rawCenter!).applyMatrix4(pose).toArray();
      const axis=new Vector3(m.axis![0],0,m.axis![1]).transformDirection(pose);
      // These approximate window dimensions are deliberately ineligible for opening-based registration.
      return {...m,rawCenter:p,center:p,width:1.72,axis:[axis.x,axis.z]};
    }),
  };
}

it("fits a named room at unit scale despite an oversized floor and differently sized windows, with disjoint faces at the check", () => {
  const s = scan([face([0,2],[4.5,2],0.38),face([9,4],[12,4])]);
  expect(matchRoomAlignment(model,s,eye)).toEqual([]);
  const local = matchRoomAlignment(model,s,eye,{ selectedRoom:true });
  expect(local).toHaveLength(1);
  expect(local[0]!.wallRegistration).toEqual({ supportCorners:3,supportWalls:4 });
  expect(local[0]!.evidenceKind).toBe("architecture");
  expect(local[0]!.errorM).toBeLessThan(1e-6);
  expect(local[0]!.fit.matrix.determinant()).toBeCloseTo(1);
  expect(roomPoseDrift(room,local[0]!.fit.matrix,pose)).toBeLessThan(1e-6);
});

it("rejects a same-floor structural wall across the corroborated interior, a wrong room, and untagged shelf geometry", () => {
  const crossing=face([0.4,1.1],[3.9,1.1]);
  expect(matchSelectedRoomCorners(model,scan([crossing]),eye).verified).toBeNull();
  expect(matchSelectedRoomCorners(model,scan([{ ...crossing,a:track([-6.8,1.1]),b:track([2.8,1.1]) }]),eye).verified).toBeNull();
  const untagged=scan();
  untagged.walls.forEach(w=>{ w.semanticWall=false; });
  expect(matchSelectedRoomCorners(model,untagged,eye).verified).toBeNull();
  const other={ ...room, footprint:{ outer:room.footprint.outer.map(([x,z]):Vec2=>[x*1.13,z]),holes:[] } };
  const wrong=buildAlignmentModel(other,calibrationFeatures({ ...manifest,rooms:[other] },other.floorId,other.id));
  wrong.landmarks=model.landmarks;
  expect(matchSelectedRoomCorners(wrong,scan(),eye).verified).toBeNull();
});

it("does not count neighboring map openings or a second candidate heading as a valid room identity", () => {
  const fromElsewhere=scan();
  fromElsewhere.landmarks[1]!.rawCenter![0]+=0.5;
  expect(matchSelectedRoomCorners(model,fromElsewhere,eye).verified).toBeNull();
  const box={ ...room, footprint:{ outer:[[0,0],[5.2,0],[5.2,5.25],[0,5.25]] as Vec2[],holes:[] } };
  const symmetric=buildAlignmentModel(box,calibrationFeatures({ ...manifest,rooms:[box] },box.floorId,box.id));
  symmetric.landmarks=[...model.landmarks,mark(3.8,5.25,[1,0]),mark(5.2,2.05,[0,1])];
  const data=scan();
  data.walls=[face([0,0],[5.2,0]),face([0,0],[0,5.25]),face([5.2,0],[5.2,5.25]),face([0,5.25],[5.2,5.25])];
  // Two visible real windows can indicate either symmetric end of this model.
  expect(matchSelectedRoomCorners(symmetric,data,eye)).toEqual({ estimate:null,verified:null });
});

it("checks the actual joined wall endpoints including floor height and refuses an unsupported fourth face", () => {
  const data=scan();
  data.walls.pop();
  expect(matchSelectedRoomCorners(model,data,eye).verified).toBeNull();
  const offLevel=scan();
  offLevel.walls.forEach(w=>{ w.low+=0.08; });
  expect(matchSelectedRoomCorners(model,offLevel,eye).verified).toBeNull();
});
