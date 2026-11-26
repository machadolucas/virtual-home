import { z } from "zod";

const metres = z.number().min(0.05).max(3);
export const fitSpec = z.strictObject({
  kind: z.enum(["Washer", "Cabinet", "Appliance"]),
  width: metres,
  depth: metres,
  height: metres,
  opening: z.enum(["Left hinge", "Right hinge", "Drawer"]),
  reach: metres,
});
export const fitPose = z.strictObject({
  x: z.number().finite(),
  z: z.number().finite(),
  yaw: z.number().min(-180).max(180),
});
export const fitDraft = z.strictObject({
  replaces: z
    .strictObject({ kind: z.enum(["equipment", "furnishing"]), id: z.string().min(1).max(160) })
    .optional(),
  spec: fitSpec,
  arrangements: z.tuple([fitPose, fitPose]),
  preferred: z.enum(["A", "B"]),
});
export const fitInput = z.strictObject({
  requestId: z.uuid(),
  fingerprint: z.string().min(8).max(128),
  roomId: z.string().min(1).max(128),
  draft: fitDraft,
});
export type FitSpec = z.infer<typeof fitSpec>;
export type FitPose = z.infer<typeof fitPose>;
export type FitDraft = z.infer<typeof fitDraft>;
export interface FitRecord {
  id: string;
  draft: FitDraft;
  createdAtMs: number;
}
export const fitPresets: Record<FitSpec["kind"], FitSpec> = {
  Washer: { kind: "Washer", width: 0.6, depth: 0.65, height: 0.85, opening: "Left hinge", reach: 0.45 },
  Cabinet: { kind: "Cabinet", width: 0.8, depth: 0.55, height: 0.9, opening: "Drawer", reach: 0.46 },
  Appliance: {
    kind: "Appliance",
    width: 0.6,
    depth: 0.6,
    height: 0.85,
    opening: "Right hinge",
    reach: 0.55,
  },
};
