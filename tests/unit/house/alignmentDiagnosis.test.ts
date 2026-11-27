import { Matrix4, Vector3 } from "three";
import { expect, it } from "vitest";
import type { Room, Vec2 } from "@/house/model/types";
import { diagnoseRoomAttempt } from "@/house/xr/alignmentDiagnosis";
import { replayAlignmentSnapshot } from "@/house/xr/replayAlignmentSnapshot";
import { localizedPerimeterDifference } from "@/house/xr/perimeterDifference";
import { calibrationFeatures } from "@/house/xr/mixedCalibration";
import {
  buildAlignmentModel, matchRoomAlignment, newAlignmentSearchDiagnostics, roomPoseDrift, uniqueRoomAlignment,
  type AlignmentLandmark, type AlignmentWall, type RoomEvidence,
} from "@/house/xr/roomAlignment";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = loadManifest(FIXTURE_DIR);
const room: Room = { ...manifest.rooms[0]!, floorElevation:0, ceilingHeight:2.6,
  footprint:{ outer:[[0,0],[5.6,0],[5.6,1.6],[6.45,2.45],[6.45,3.55],[5.6,4.4],[5.6,6],[0,6],[-1.3,4.7],[-1.3,3.3],[0,3.3]],holes:[] } };
const eye = new Vector3(2,1.6,3);
const points = calibrationFeatures({ ...manifest,rooms:[room] },room.floorId,room.id);
const door: AlignmentLandmark = { kind:"door",width:0.85,height:2.05,center:[1,1.025,0],rawCenter:[1,1.025,-0.075],axis:[1,0] };
const window: AlignmentLandmark = { kind:"window",width:1.4,height:1.1,center:[3,1.42,6],rawCenter:[3,1.42,6.06],axis:[-1,0] };
const model = { ...buildAlignmentModel(room,points),landmarks:[door,window] };
const face = (a:Vec2,b:Vec2):AlignmentWall => ({ a,b,low:1.15,high:2.22,semanticWall:true });
const simplified:RoomEvidence = { walls:[face([5.6,1.6],[5.6,4.4])],landmarks:[door,window],
  floor:{ source:"plane",semanticFloor:true,y:0,outline:[[0,0],[5.6,0],[5.6,6],[0,6],[-1.3,4.7],[-1.3,3.3],[0,3.3]] } };

it("allows a selected room's independent opening pair past a single squared-off nook and reports its affected model walls", () => {
  const baseline = newAlignmentSearchDiagnostics();
  expect(matchRoomAlignment(model,simplified,eye,{ diagnostics:baseline })).toEqual([]);
  expect(baseline.contradictedWall).toBe(true);
  const search = newAlignmentSearchDiagnostics();
  const candidates = matchRoomAlignment(model,simplified,eye,{ selectedRoom:true,diagnostics:search });
  const accepted = uniqueRoomAlignment(candidates);
  expect(accepted).toBeTruthy();
  expect(roomPoseDrift(room,new Matrix4(),accepted!.fit.matrix)).toBeCloseTo(0);
  const report = diagnoseRoomAttempt(model,simplified,eye,candidates,{ verifiedPose:accepted!.fit.matrix,search });
  expect(report.stage).toBe("verified");
  expect(report.bestCheckM).toBeCloseTo(0);
  expect(report.outline?.maxDeviationM).toBeCloseTo(0.85,2);
  expect(report.outline?.walls.map(w=>w.wallIndex).sort()).toEqual([2,3,4]);
  expect(report.outline?.walls.find(w=>w.wallIndex===2)?.nearestAngleDeg).toBeCloseTo(45,2);
});

it("refuses an unrelated wall conflict, missing independent measurement, non-semantic floor or mismatch at a second location", () => {
  const selected = { selectedRoom:true };
  expect(matchRoomAlignment(model,{ ...simplified,walls:[...simplified.walls,face([1.2,3.5],[3.4,3.5])] },eye,selected)).toEqual([]);
  expect(matchRoomAlignment(model,{ ...simplified,walls:[...simplified.walls,face([1.2,4.2],[16,4.2])] },eye,selected)).toEqual([]);
  expect(matchRoomAlignment(model,{ ...simplified,landmarks:[door] },eye,selected)).toEqual([]);
  expect(matchRoomAlignment(model,{ ...simplified,floor:{ ...simplified.floor!,semanticFloor:false } },eye,selected)).toEqual([]);
  const floor = { ...simplified.floor!, outline:[...simplified.floor!.outline] };
  floor.outline[5]=[-0.92,3.3];
  expect(localizedPerimeterDifference(room,floor,new Matrix4())).toBeNull();
  expect(matchRoomAlignment(model,{ ...simplified,floor },eye,selected)).toEqual([]);
});

it("keeps even a distinctive outline mismatch diagnostic when no independent observation establishes the pose", () => {
  const raw = { ...simplified,walls:[],landmarks:[] };
  const report = diagnoseRoomAttempt(model,raw,eye);
  expect(report.outline?.basis).toBe("hypothesis");
  expect(report.outline?.plausiblePoses).toBe(1);
  expect(report.reason).toBe("local-outline-discrepancy");
  expect(report.bestCheckM).toBeNull();
  expect(matchRoomAlignment(model,raw,eye,{ selectedRoom:true })).toEqual([]);
});

it("withholds wall attribution when a squared floor permits opposing explanations", () => {
  const beveled:Room = { ...room,footprint:{ outer:[[0,0],[6,0],[6,3.5],[5.5,4],[0,4]],holes:[] } };
  const fixed = buildAlignmentModel(beveled,calibrationFeatures({ ...manifest,rooms:[beveled] },beveled.floorId,beveled.id));
  const rectangle:RoomEvidence = { walls:[],landmarks:[],floor:{ y:0,semanticFloor:true,source:"plane",outline:[[0,0],[6,0],[6,4],[0,4]] } };
  const compared = diagnoseRoomAttempt(fixed,rectangle,eye);
  expect(compared.reason).toBe("outline-heading-ambiguous");
  expect(compared.outline?.plausiblePoses).toBeGreaterThan(1);
  expect(compared.outline?.walls).toEqual([]);
  expect(compared.outline?.maxDeviationM).toBeNull();
  expect(compared.bestCheckM).toBeNull();
  expect(matchRoomAlignment(fixed,rectangle,eye,{ selectedRoom:true })).toEqual([]);
});

it("records an actual held-out 3D gap for a rejected feature and leaves absent checks unknown", () => {
  const search = newAlignmentSearchDiagnostics();
  const bad:AlignmentLandmark = { ...window,rawCenter:[3,1.491,6.06] };
  const scene = { ...simplified,walls:[],landmarks:[door,bad] };
  const candidates = matchRoomAlignment(model,scene,eye,{ selectedRoom:true,diagnostics:search });
  expect(candidates).toEqual([]);
  const report = diagnoseRoomAttempt(model,scene,eye,candidates,{ search });
  expect(report.bestCheckM).toBeCloseTo(0.071);
  expect(report.independentChecks).toBeGreaterThan(0);
  expect(report.reason).toBe("independent-check-exceeds-tolerance");
  const empty = diagnoseRoomAttempt(null,{floor:null,walls:[],landmarks:[]},eye);
  expect(empty.reason).toBe("no-scan-geometry");
  expect(empty.bestCheckM).toBeNull();
});

it("reports measured endpoint disagreements separately from a verified third point on a six-stroke failure", () => {
  const stroke = (a:Vec2,b:Vec2):AlignmentWall => ({ a,b,low:0,high:0,baseOnly:true });
  const strokes = [stroke([0.4,0],[1.5,0]),stroke([5.6,0.1],[5.6,1.25]),stroke([6.45,2.47],[6.45,3.54]),
    stroke([4,6],[2.45,6]),stroke([0,0.7],[0,2.05]),stroke([-1.12,3.43],[-1.12,4.53])];
  const evidence:RoomEvidence = { floor:{source:"bounds",outline:[],y:0},walls:strokes,landmarks:[] };
  const search = newAlignmentSearchDiagnostics();
  const candidates = matchRoomAlignment(model,evidence,eye,{diagnostics:search});
  expect(candidates).toEqual([]);
  const report = diagnoseRoomAttempt(model,evidence,eye,candidates,{search});
  expect(report.reason).toBe("marked-wall-endpoints-disagree");
  expect(report.bestTraceGapM).toBeGreaterThan(0.10);
  expect(report.bestCheckM).toBeNull();
  expect(report.fittedPairs).toBeGreaterThan(0);
});


it("replays a retained native snapshot without mixing tracking spaces or treating shape diagnosis as successful calibration", () => {
  const snapshot = { ...simplified,atMs:1_500,space:0,roomId:room.id,viewer:eye.toArray(),traces:[],diagnosis:null };
  expect(replayAlignmentSnapshot(model,snapshot).reason).toBe("observed-wall-crosses-fitted-room");
  const namedRoom = replayAlignmentSnapshot(model,snapshot,{ selectedRoom:true });
  expect(namedRoom.reason).toBe("checked-pose-found");
  expect(namedRoom.stage).toBe("check");
  expect(namedRoom.bestCheckM).toBeCloseTo(0);
});

it("replays stored room choice, measured split-level floor and the wearer's explicit wall pairings", () => {
  const roomOnly = { ...simplified,atMs:1_500,space:0,roomId:room.id,viewer:eye.toArray(),traces:[],diagnosis:null,selectedRoom:true };
  expect(replayAlignmentSnapshot(model,roomOnly).reason).toBe("checked-pose-found");
  const rectangle:Room = { ...room,footprint:{ outer:[[0,0],[5,0],[5,3],[0,3]],holes:[] } };
  const fixed = buildAlignmentModel(rectangle,calibrationFeatures({ ...manifest,rooms:[rectangle] },rectangle.floorId,rectangle.id));
  const stroke = (a:Vec2,b:Vec2):AlignmentWall => ({ a,b,low:0.32,high:0.32,baseOnly:true });
  const traces = [stroke([1,0],[2.5,0]),stroke([5,0.5],[5,1.7]),stroke([1,3],[2.5,3]),stroke([0,0.5],[0,1.7]),
    stroke([2.1,0.3],[3.6,0.3])];
  const snapshot = { ...roomOnly,floor:null,walls:[],landmarks:[],traces,viewer:new Vector3(2,1.9,1.5).toArray(),
    traceFloor:{ y:0.32,measured:true }, wallPairs: [0,1,2,3].map(i=>({trace:i,wall:i})) };
  expect(replayAlignmentSnapshot(fixed,snapshot).reason).toBe("checked-pose-found");
  expect(replayAlignmentSnapshot(fixed,{ ...snapshot,wallPairs:[] }).candidateCount).toBe(0);
  expect(replayAlignmentSnapshot(fixed,{ ...snapshot,traceFloor:{ y:0.32,measured:false } }).candidateCount).toBe(0);
  const bad = replayAlignmentSnapshot(fixed,{ ...snapshot,wallPairs: [1,0,2,3].map((wall,trace)=>({wall,trace})) });
  expect(bad.reason).toBe("marked-plan-correspondence-conflict");
  expect(bad.bestCheckM).toBeNull();
});
