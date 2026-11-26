import { z } from "zod";
import type { Vec3 } from "../model/types";
import type { FrozenChecklistItem, FrozenProcedure, ProgressRow } from "@/server/queries/maintenance/task";
import type { MaterialLine } from "@/features/maintenance/materials";

export const HEADSET_PURPOSES = {
  water_shutoff: "Find the water shutoff",
  ventilation_filter: "Find the ventilation filter",
  electrical_panel: "Find the electrical panel",
} as const;

export const headsetId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).max(160);
export const headsetFindInput = z.strictObject({
  purpose: z.enum(["water_shutoff", "ventilation_filter", "electrical_panel"]).optional(),
  category: z.string().max(32).optional(),
  roomId: headsetId.optional(),
  onlyRoom: z.boolean().optional(),
  q: z.string().trim().max(80).optional(),
  offset: z.number().int().min(0).max(2000).default(0),
});
export type HeadsetFindInput = z.input<typeof headsetFindInput>;

export interface HeadsetLocateTarget {
  kind: "equipment" | "endpoint";
  id: string;
  name: string;
  assetId: string | null;
  placementId: string | null;
  endpointId: string | null;
  routeIds: string[];
  roomId: string | null;
  floorId: string | null;
  roomName: string | null;
  floorName: string | null;
  position: Vec3 | null;
  category: string | null;
  modelName: string | null;
  finding?: "air_handler_filter_unrecorded";
  servedFixtures: { id: string; name: string }[];
}
export interface HeadsetSearchPage {
  items: HeadsetLocateTarget[];
  nextOffset: number | null;
}

export interface HeadsetIllustration {
  attachmentId: string;
  label: string;
  kind: "image" | "pdf";
  page?: number;
  preferredVariant?: "web" | "thumb";
}

export interface HeadsetStepPin {
  target: HeadsetLocateTarget;
  taskTitle: string;
  title: string;
  body: string;
  warning?: string;
  index: number;
  total: number;
  illustration?: HeadsetIllustration;
}

export interface HeadsetTaskRow {
  id: string;
  title: string;
  status: "pending" | "due";
  dueDate: string;
  priority: string;
}

export interface HeadsetPartSpec {
  partId: string;
  name: string;
  spec: string | null;
  dimensions: string | null;
  productCode: string | null;
  manufacturer: string | null;
  stockMilli: number | null;
  unit: MaterialLine["unit"];
  lastUseDate: string | null;
  lastReplacementDate: string | null;
}

export interface HeadsetMaintenanceOverview {
  target: HeadsetLocateTarget;
  tasks: HeadsetTaskRow[];
  lastWork: { title: string; date: string; outcome: string } | null;
  parts: HeadsetPartSpec[];
}

export interface HeadsetMaintenanceTask extends HeadsetTaskRow {
  description: string | null;
  procedure: FrozenProcedure | null;
  progress: ProgressRow[];
  materials: MaterialLine[];
  requiresProfessional: boolean;
  providers: { id: string; name: string }[];
  photos: { id: string; label: string }[];
  illustrations: { stepId: string | null; previews: HeadsetIllustration[] }[];
}

export const headsetTaskWrite = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("step"), occurrenceId: headsetId, stepId: headsetId,
    state: z.enum(["done", "skipped", "todo"]),
  }),
  z.strictObject({
    kind: z.literal("checklist"), occurrenceId: headsetId, itemId: headsetId,
    state: z.enum(["done", "todo"]), value: z.union([z.string().trim().max(500), z.number().finite()]).optional(),
  }),
  z.strictObject({
    kind: z.literal("complete"), occurrenceId: headsetId, requestId: z.uuid(), confirmed: z.literal(true),
    providerId: headsetId.optional(),
    outcome: z.enum(["done", "done_with_issues", "partial"]),
    materials: z.array(z.strictObject({ partId: headsetId, actualQtyMilli: z.number().int().min(0).max(1_000_000_000),
      resolutionIfShort: z.enum(["adjust_up", "consume_available", "note_discrepancy"]).optional() })).max(50),
  }),
]);
export type HeadsetTaskWrite = z.infer<typeof headsetTaskWrite>;
export type HeadsetChecklistField = FrozenChecklistItem;
