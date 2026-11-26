"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ScanLine } from "lucide-react";
import { Matrix4, Vector3 } from "three";
import { Button, Dialog } from "@/ui";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";
import { getModelFix } from "../modelFixApi";
import type { ModelFix } from "../modelFixTypes";
import {
  getRoomSurvey, getRoomSurveyGeometry, listRoomSurveys, OPEN_ROOM_SURVEY,
} from "../roomSurveyApi";
import { reviewRoomSurveyMove } from "../roomSurveyReview";
import type { RoomSurvey, RoomSurveyGeometry, RoomSurveyMove, RoomSurveyPage, RoomSurveyPose, StoredRoomSurveyComparison } from "../roomSurveyTypes";
import { equipmentPreviewShape } from "../scene/equipmentPlacement";
import { furnishingGeometry } from "../scene/furnishingGeometry";
import { SurveyDisplay } from "../xr/surveyDisplay";
import { surveyExtent } from "../xr/surveyGeometry";
import { requestEditSwitch } from "./edit/confirmSwitch";
import { useFurnishings } from "./furnishings/FurnishingsProvider";

const number = (value: number) => value.toFixed(1);
const sources = { plane: "Planes", mesh: "Meshes", "hit-test": "Hit-test points", manual: "Manual points" } as const;
const measurementKinds = { distance: "Distance", ceiling_height: "Ceiling height", opening_width: "Opening width", opening_height: "Opening height" } as const;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Could not load the survey.";
const poseText = ({ position, yawDeg }: RoomSurveyPose) => `${position.map((value) => value.toFixed(3)).join(", ")} m · ${number(yawDeg)}°`;

interface Preview {
  survey: RoomSurvey;
  geometry: RoomSurveyGeometry;
  move?: RoomSurveyMove;
  comparison?: StoredRoomSurveyComparison;
}

export function RoomSurveys() {
  const runtime = useHouseRuntime();
  const furnishings = useFurnishings();
  const fingerprint = useHouseStore((s) => s.fingerprint);
  const immersive = useHouseStore((s) => s.immersiveMode);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<RoomSurveyPage | null>(null);
  const [survey, setSurvey] = useState<RoomSurvey | null>(null);
  const [fix, setFix] = useState<ModelFix | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [confirming, setConfirming] = useState<{ move: RoomSurveyMove; action: "apply" | "undo" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const base = runtime.base;

  const show = useCallback(async (id?: string, cursor?: string) => {
    const load = ++generation.current;
    setWaiting(true);
    setError(null);
    try {
      if (id) {
        const record = await getRoomSurvey(base, id);
        if (generation.current === load) {
          setSurvey(record);
          setFix(null);
          setConfirming(null);
        }
      } else {
        const next = await listRoomSurveys(base, undefined, cursor);
        if (generation.current === load) setPage((previous) => cursor && previous
          ? { items: [...previous.items, ...next.items], nextCursor: next.nextCursor } : next);
      }
    } catch (err) {
      if (generation.current === load) setError(errorText(err));
    } finally {
      if (generation.current === load) setWaiting(false);
    }
  }, [base]);

  useEffect(() => {
    const showSurvey = (event: Event) => {
      const surveyId = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (!surveyId) return;
      setOpen(true);
      void show(surveyId);
    };
    window.addEventListener(OPEN_ROOM_SURVEY, showSurvey);
    return () => window.removeEventListener(OPEN_ROOM_SURVEY, showSurvey);
  }, [show]);

  const previewActive = !!preview && preview.survey.fingerprint === fingerprint && !immersive;
  useEffect(() => {
    if (!preview || !previewActive) return;
    const scene = runtime.scene;
    const room = runtime.manifest?.rooms.get(preview.survey.roomId);
    if (!scene || !room) return;
    const display = new SurveyDisplay(room);
    const { bounds } = surveyExtent(preview.geometry, room);
    display.showGeometry(preview.geometry, bounds);
    const move = preview.move;
    if (move) {
      const equipment = move.target.kind === "equipment"
        ? runtime.store.getState().placements.find((item) => item.id === move.target.id) : undefined;
      const furnishing = move.target.kind === "furnishing" ? furnishings.items.find((item) => item.id === move.target.id) : undefined;
      const shape = equipment ? equipmentPreviewShape(equipment) : furnishing ? {
        geometry: furnishingGeometry(furnishing.kind),
        scale: new Vector3(furnishing.widthM, furnishing.heightM, furnishing.depthM),
      } : undefined;
      display.compare(move.before, move.after, shape);
    }
    if (preview.comparison) display.showDiscrepancy(preview.comparison);
    display.apply(new Matrix4());
    scene.add(display.group);
    runtime.invalidate();
    const comparisonBounds = bounds.clone().makeEmpty();
    if (preview.comparison)
      for (const point of [...preview.comparison.scanOutline, ...preview.comparison.modelOutline])
        comparisonBounds.expandByPoint(new Vector3(...point));
    void runtime.camera?.fitBox(preview.comparison ? comparisonBounds.expandByScalar(0.35) : bounds, { padding: 0.6 });
    return () => { display.dispose(); runtime.invalidate(); };
  }, [furnishings.items, preview, previewActive, runtime]);

  const previewSurvey = async (record: RoomSurvey, evidence?: { move: RoomSurveyMove } | { comparison: StoredRoomSurveyComparison }) => {
    setWaiting(true);
    setError(null);
    try {
      const geometry = await getRoomSurveyGeometry(base, record.id);
      if (!runtime.scene || record.fingerprint !== runtime.store.getState().fingerprint)
        throw new Error("Load the matching model revision to align this survey in the house viewer.");
      setOpen(false);
      await requestEditSwitch(runtime, () => {
        const state = runtime.store.getState();
        state.setExplode({ enabled: false });
        state.isolateFloor(record.floorId);
        runtime.select({ kind: "room", id: record.roomId }, { focus: true });
        setPreview({ survey: record, geometry, ...evidence });
        state.announce("Room survey preview opened.");
      });
    } catch (err) {
      setOpen(true);
      setError(errorText(err));
    } finally { setWaiting(false); }
  };

  const change = async () => {
    if (!survey || !confirming) return;
    setWaiting(true);
    setError(null);
    try {
      const { move, action } = confirming;
      const state = runtime.store.getState();
      if (state.editing || state.routeDraft || state.furnishingsEditing)
        throw new Error("Finish the open edit before changing a surveyed placement.");
      const stored = await reviewRoomSurveyMove(runtime, survey, move, action);
      setSurvey({ ...survey, moves: survey.moves.map((item) => item.id === stored.id ? stored : item) });
      setConfirming(null);
      setMessage(action === "apply" ? "Survey move applied." : "Previous placement restored.");
    } catch (err) {
      setError(errorText(err));
    } finally { setWaiting(false); }
  };

  const readFix = async (id: string) => {
    setWaiting(true);
    setError(null);
    try {
      setFix(await getModelFix(base, id));
    } catch (err) {
      setError(errorText(err));
    } finally { setWaiting(false); }
  };

  return <div className="flex flex-wrap items-center gap-1">
    <Dialog open={open} onOpenChange={(next) => {
      if (waiting && open) return;
      setOpen(next);
      setError(null);
      setMessage(null);
      if (next && !survey) void show();
    }} trigger={<Button size="sm" variant="ghost" icon={<ScanLine className="size-4" />}>Room surveys</Button>}
      title={survey?.roomName ?? "Room surveys"} size="lg"
      description={survey ? "Review saved geometry, measurements and proposed placement changes." : "Saved whole-room surveys from mixed reality."}>
      {error && <p role="alert" className="mb-3 text-overdue">{error}</p>}
      {message && <p role="status" className="mb-3">{message}</p>}
      {survey ? <div className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={waiting} onClick={() => {
            setSurvey(null);
            setConfirming(null);
            void show();
          }}>All surveys</Button>
          <Button size="sm" disabled={waiting || survey.fingerprint !== fingerprint} onClick={() => void previewSurvey(survey)}>Preview in house</Button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>Captured</dt><dd>{new Date(survey.capturedAtMs).toLocaleString()}</dd>
          <dt>Alignment residual</dt><dd>{number(survey.registrationErrorM * 100)} cm</dd>
          <dt>Capture</dt><dd>{survey.statistics.scope === "full" ? "Full headset geometry" : survey.statistics.scope === "manual" ? "Manual evidence" : "Bounded evidence"}</dd>
          <dt>Extent</dt><dd>{survey.statistics.extent.max.map((value, index) => number(value - survey.statistics.extent.min[index]!)).join(" × ")} m
            {survey.statistics.includesAdjoining ? " · includes adjoining area" : ""}</dd>
          <dt>Geometry</dt><dd>{Object.entries(survey.statistics.sources).map(([source, count]) =>
            `${sources[source as keyof typeof sources]} (${count})`).join(", ") || "Measured pairs"}</dd>
          <dt>Model revision</dt><dd className="break-all font-mono text-xs">{survey.fingerprint}</dd>
        </dl>
        {survey.fingerprint !== fingerprint && <p>Earlier model revision. The evidence remains available below.</p>}
        {survey.measurements.length > 0 && <section>
          <h3 className="font-semibold text-ink">Measurements</h3>
          <ul>{survey.measurements.map((measurement, index) => <li key={index}>
            {measurementKinds[measurement.kind]} · {number(measurement.lengthM * 100)} cm
          </li>)}</ul>
        </section>}
        {survey.moves.length > 0 && <section className="grid gap-2">
          <h3 className="font-semibold text-ink">Placement corrections</h3>
          {survey.moves.map((move) => <article key={move.id} className="grid gap-2 rounded-lg border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="font-medium text-ink">{move.target.name}</h4>
              <span>{move.status === "proposed" ? "Pending" : move.status === "applied" ? "Applied" : "Undone"}</span>
            </div>
            <dl className="grid gap-1 sm:grid-cols-[auto_1fr] sm:gap-x-3">
              <dt>Recorded</dt><dd>{poseText(move.before)}</dd>
              <dt>Measured</dt><dd>{poseText(move.after)}</dd>
              <dt>Difference</dt><dd>{number(move.displacementCm)} cm · {number(move.headingChangeDeg)}°</dd>
              <dt>Alignment residual</dt><dd>{number(move.registrationErrorM * 100)} cm</dd>
            </dl>
            {move.applyBlockedReason && <p>Saved for manual review of the mounting surface.</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={waiting || survey.fingerprint !== fingerprint} onClick={() => void previewSurvey(survey, { move })}>Compare in house</Button>
              {move.status === "proposed" && !move.applyBlockedReason && <Button size="sm" disabled={waiting || survey.fingerprint !== fingerprint}
                onClick={() => setConfirming({ move, action: "apply" })}>Review and apply</Button>}
              {move.status === "applied" && <Button size="sm" disabled={waiting || survey.fingerprint !== fingerprint}
                onClick={() => setConfirming({ move, action: "undo" })}>Undo move</Button>}
            </div>
            {confirming?.move.id === move.id && <div className="flex flex-wrap items-center gap-2">
              <span>{confirming.action === "apply" ? "Apply this measured placement?" : "Restore the recorded placement?"}</span>
              <Button size="sm" variant="primary" loading={waiting} onClick={() => void change()}>
                {confirming.action === "apply" ? "Apply placement" : "Restore placement"}
              </Button>
              <Button size="sm" variant="ghost" disabled={waiting} onClick={() => setConfirming(null)}>Cancel</Button>
            </div>}
          </article>)}
        </section>}
        {survey.observations.length > 0 && <section className="grid gap-2">
          <h3 className="font-semibold text-ink">Linked model fixes</h3>
          {survey.observations.map((entry) => <div key={entry.fixId} className="grid gap-1">
            <Button className="w-fit" size="sm" disabled={waiting} onClick={() => void readFix(entry.fixId)}>
              {entry.comparison ? entry.comparison.label : entry.kind === "structure" ? "Structural observation" : "New object observation"}
            </Button>
            {entry.comparison && <div className="flex flex-wrap items-center gap-2">
              <span>{number(entry.comparison.offsetM * 100)} cm offset · alignment {number(entry.comparison.registrationErrorM * 100)} cm · scan fit ±{number(entry.comparison.scanUncertaintyM * 100)} cm</span>
              <Button size="sm" disabled={waiting || survey.fingerprint !== fingerprint}
                onClick={() => void previewSurvey(survey, { comparison: entry.comparison! })}>Compare outlines in house</Button>
            </div>}
            {fix?.id === entry.fixId && <p>{fix.status === "pending" ? "Pending" : "Resolved"} · {fix.description}</p>}
          </div>)}
        </section>}
      </div> : <div className="grid gap-3">
        {page === null ? waiting ? <p role="status">Loading surveys…</p> : <Button size="sm" onClick={() => void show()}>Load surveys</Button>
          : page.items.length === 0 ? <p>No room surveys have been saved.</p>
            : <ul className="grid gap-2">{page.items.map((record) => <li key={record.id}>
              <button type="button" disabled={waiting} onClick={() => void show(record.id)}
                className="grid w-full gap-1 rounded-md border border-line px-3 py-2 text-left hover:bg-surface-3">
                <span className="font-medium text-ink">{record.roomName}</span>
                <span>{new Date(record.capturedAtMs).toLocaleString()} · {number(record.registrationErrorM * 100)} cm alignment residual</span>
              </button>
            </li>)}</ul>}
        {page?.nextCursor && <Button size="sm" disabled={waiting} onClick={() => void show(undefined, page.nextCursor!)}>Load more</Button>}
      </div>}
    </Dialog>
    {previewActive && <Button size="sm" onClick={() => setPreview(null)}>Hide survey preview</Button>}
  </div>;
}
