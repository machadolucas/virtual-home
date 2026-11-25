import type {
  RoomSurvey, RoomSurveyCapture, RoomSurveyGeometry, RoomSurveyMove, RoomSurveyMoveInput,
  RoomSurveyObservation, RoomSurveyObservationInput, RoomSurveyPage, RoomSurveySummary,
} from "./roomSurveyTypes";

export const ROOM_SURVEY_PLACEMENT_CHANGED = "virtual-home:room-survey-placement-changed";
export const OPEN_ROOM_SURVEY = "virtual-home:open-room-survey";
const messages: Record<string, string> = {
  survey_model_changed: "The survey belongs to a previous model revision. Capture new evidence before moving anything.",
  survey_target_changed: "This object's placement changed after review. Make a new measurement.",
  survey_target_not_movable: "Use a model fix for a wall, ceiling, surface-mounted or unavailable object.",
  survey_outside_room: "The sampled point belongs outside the surveyed room.",
  survey_move_no_change: "The sampled pose matches the recorded pose.",
  survey_body_too_large: "The room evidence exceeds the upload size limit.",
  survey_placement_collision: "The proposed object placement intersects a wall or another object.",
};

function surveyUrl(base: string, id: string) {
  return `${base}/surveys/${encodeURIComponent(id)}`;
}

async function request<T>(url: string, method = "GET", value?: unknown): Promise<T> {
  const response = await fetch(url, {
    method, cache: "no-store",
    ...(value === undefined ? {} : {
      headers: { "content-type": "application/json", "x-vh-room-survey": "1" },
      body: JSON.stringify(value),
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    const code = data?.error ?? "";
    throw new Error(messages[code] ?? (response.status === 401 ? "Sign in again to continue." : "The room survey request could not be completed."));
  }
  return response.json() as Promise<T>;
}

export function saveRoomSurvey(base: string, input: RoomSurveyCapture) {
  return request<RoomSurveySummary>(`${base}/surveys`, "POST", input);
}

export function listRoomSurveys(base: string, roomId?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (roomId) params.set("roomId", roomId);
  if (cursor) params.set("cursor", cursor);
  return request<RoomSurveyPage>(`${base}/surveys?${params}`);
}

export function getRoomSurvey(base: string, id: string) {
  return request<RoomSurvey>(surveyUrl(base, id));
}

export function getRoomSurveyGeometry(base: string, id: string) {
  return request<RoomSurveyGeometry>(`${surveyUrl(base, id)}/geometry`);
}

export function proposeRoomSurveyMove(base: string, id: string, input: RoomSurveyMoveInput) {
  return request<RoomSurveyMove>(`${surveyUrl(base, id)}/moves`, "POST", input);
}

async function changeMove(base: string, id: string, moveId: string, action: "apply" | "undo") {
  const move = await request<RoomSurveyMove>(`${surveyUrl(base, id)}/moves/${encodeURIComponent(moveId)}`, "PATCH", { action });
  window.dispatchEvent(new CustomEvent(ROOM_SURVEY_PLACEMENT_CHANGED, { detail: { base, move } }));
  return move;
}

export function applyRoomSurveyMove(base: string, id: string, moveId: string) {
  return changeMove(base, id, moveId, "apply");
}

export function undoRoomSurveyMove(base: string, id: string, moveId: string) {
  return changeMove(base, id, moveId, "undo");
}

export function recordRoomSurveyObservation(base: string, id: string, input: RoomSurveyObservationInput) {
  return request<RoomSurveyObservation>(`${surveyUrl(base, id)}/observations`, "POST", input);
}
