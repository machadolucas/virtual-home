/**
 * Public surface of the 3D house workspace.
 *
 * Everything outside `src/house/` imports from here. The module deliberately exports **no three /
 * R3F / drei symbols**: those live behind `HouseCanvasLazy` (`next/dynamic`, `ssr: false`) so a
 * maintenance screen never pulls the 3D bundle. The pure `model/` layer is safe to import from a
 * server component or a test — it has no three and no DOM.
 */

/* the shell (client component) */
export { HouseWorkspace } from "./components/HouseWorkspace";
export type { HouseWorkspaceProps } from "./components/HouseWorkspace";

/* pure model layer — no three, no DOM, unit-testable in Node */
export { safeParseManifest, formatZodIssues, ManifestSchema } from "./model/schema";
export { crossCheck, hasErrors, errorsOf } from "./model/crossref";
export type { Diagnostic, Severity } from "./model/crossref";
export { buildManifestIndex, roomAt, roomSurfaceIds } from "./model/manifestIndex";
export type { ManifestIndex, RoomAnchor } from "./model/manifestIndex";
export { reconcile, coordinateStamp } from "./model/reconcile";
export type { ReconcileReport, PersistedRefs, PersistedModelStamp } from "./model/reconcile";
export { planRoomColors, planAllSurfaces, planResetRoom, normalizeHex } from "./model/colorPlan";
export type { ColorDecision, NodeColorPlan } from "./model/colorPlan";
export {
  backgroundStyle,
  houseBackgroundSchema,
  parseHouseBackground,
  presetIdOf,
  sameBackground,
  DEFAULT_HOUSE_BACKGROUND,
  DEFAULT_GRADIENT_ANGLE_DEG,
  HOUSE_BACKGROUND_PRESETS,
} from "./model/background";
export type { HouseBackground } from "./model/background";
export { computeVisibility, DOLLHOUSE_PRESET, OVERVIEW_PRESET } from "./model/visibilityPlan";
export type { VisibilityInput, VisibilityPlan } from "./model/visibilityPlan";
export { explodeGroupOf, clipGroupOf, explodeOffset, DEFAULT_EXPLODE_GAP } from "./model/explodeGroups";
export {
  roomBox,
  floorBox,
  buildingBox,
  propertyBox,
  equipmentBox,
  routeBox,
  cutRange,
} from "./model/framingBoxes";

export type {
  AssetId,
  BuildingId,
  ElementId,
  FloorId,
  LayerId,
  LoadPhase,
  Manifest,
  Placement,
  PlacementId,
  PlacementMount,
  Projection,
  Room,
  RoomId,
  Route,
  RouteId,
  Selection,
  Surface,
  SurfaceId,
  ViewMode,
} from "./model/types";

/* persistence seam, so another module can hand the workspace its own implementation */
export type { HouseDataApi, ColorOverrideWrite } from "./store/dataApi";
export { NotPersistedError } from "./store/dataApi";
