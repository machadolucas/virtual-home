/**
 * Zod mirror of the model package's `manifest.schema.json` (shared model-package contract v1.0,
 * Example House extensions).
 *
 * Rules followed here:
 *  - Every object is a **loose** object (`z.looseObject`), because the JSON Schema sets
 *    `additionalProperties: true`. A future package revision that adds fields must not fail
 *    validation; unknown fields survive parsing and stay available through `userData`-style access.
 *  - Enums list every value the JSON Schema allows, including the two the prose brief omitted:
 *    room kind `closet` (used by `r-g-closet-entrance`) and certainty `derived`.
 *  - Nothing here imports three.js or React: this module is pure and unit-tested in Node.
 */
import { z } from "zod";

/** `#/$defs/id` — stable application key. Never a node index or a display name. */
export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "invalid id");
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export const Vec2Schema = z.tuple([z.number(), z.number()]);
export const RingSchema = z.array(Vec2Schema).min(3);
export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb");
export const CertaintySchema = z.enum(["measured", "derived", "inferred", "unknown"]);
export const AssetPathSchema = z.string().regex(/^assets\/[A-Za-z0-9._-]+\.glb$/, "invalid asset path");

export const NodeRefSchema = z.looseObject({
  assetId: IdSchema,
  nodeName: z.string().min(1),
});

export const BoxSchema = z.looseObject({ min: Vec3Schema, max: Vec3Schema });

export const CoordinateSystemSchema = z.looseObject({
  units: z.literal("m"),
  upAxis: z.literal("Y"),
  handedness: z.literal("right"),
  originDescription: z.string().min(10),
  siteElevationOffset: z.number().optional(),
  north: z
    .looseObject({
      bearingDeg: z.number().min(-180).max(360),
      certainty: CertaintySchema,
      description: z.string().optional(),
    })
    .optional(),
  geoAnchor: z
    .looseObject({
      lat: z.number(),
      lon: z.number(),
      description: z.string().optional(),
      certainty: CertaintySchema.optional(),
    })
    .optional(),
  floorDatums: z.record(z.string(), z.number()).optional(),
});

export const BoundsSchema = z.looseObject({
  min: Vec3Schema,
  max: Vec3Schema,
  note: z.string().optional(),
});

export const BuildingSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  placementStatus: z.enum(["verified", "inferred", "unresolved"]),
  placementNotes: z.string().optional(),
  floorIds: z.array(IdSchema).default([]),
  assetIds: z.array(IdSchema).default([]),
  localFrame: z
    .looseObject({ translate: Vec3Schema.optional(), description: z.string().optional() })
    .optional(),
});

export const FloorSchema = z.looseObject({
  id: IdSchema,
  buildingId: IdSchema,
  name: z.string(),
  nameFi: z.string().nullable().optional(),
  elevation: z.number(),
  assetIds: z.array(IdSchema).default([]),
  scanAssetIds: z.array(IdSchema).default([]),
  roomIds: z.array(IdSchema).default([]),
});

export const RoomKindSchema = z.enum(["room", "attic", "void", "closet"]);

export const RoomSchema = z.looseObject({
  id: IdSchema,
  floorId: IdSchema,
  buildingId: IdSchema.optional(),
  name: z.string(),
  nameFi: z.string().nullable().optional(),
  aliases: z.array(z.string()).default([]),
  kind: RoomKindSchema.optional(),
  note: z.string().nullable().optional(),
  floorElevation: z.number(),
  ceilingHeight: z.number().optional(),
  certainty: CertaintySchema.optional(),
  area: z.number().optional(),
  color: ColorSchema.optional(),
  footprint: z.looseObject({
    outer: RingSchema,
    holes: z.array(RingSchema).default([]),
  }),
  surfaceIds: z.array(IdSchema).default([]),
});

export const AssetKindSchema = z.enum(["shell", "terrain", "detail", "scan-reference"]);

export const AssetSchema = z.looseObject({
  id: IdSchema,
  path: AssetPathSchema,
  kind: AssetKindSchema,
  loadByDefault: z.boolean(),
  buildingId: IdSchema.optional(),
  floorId: IdSchema.optional(),
  edgesNode: z.string().nullable().optional(),
  bounds: z.looseObject({ min: Vec3Schema.optional(), max: Vec3Schema.optional() }).optional(),
  stats: z.looseObject({}).nullable().optional(),
});

export const ElementKindSchema = z.enum([
  "wall",
  "exterior-wall",
  "door",
  "window",
  "opening",
  "floor",
  "ceiling",
  "slab-edge",
  "stair",
  "step",
  "railing",
  "roof",
  "dormer",
  "chimney",
  "fireplace",
  "terrace",
  "balcony",
  "terrain",
  "paving",
  "footprint",
  "roof-access",
  "truss",
  "beam",
  "footing",
  "slab",
  "frame",
  "concrete",
  "scan-reference",
]);

export const ElementSchema = z.looseObject({
  id: IdSchema,
  kind: ElementKindSchema,
  buildingId: IdSchema.optional(),
  floorId: IdSchema.optional(),
  roomIds: z.array(IdSchema).optional(),
  wallId: IdSchema.optional(),
  nodeRefs: z.array(NodeRefSchema).min(1),
  surfaceIds: z.array(IdSchema).default([]),
  certainty: CertaintySchema,
  sourceRefs: z.array(IdSchema).default([]),
  properties: z.looseObject({}).optional(),
  note: z.string().nullable().optional(),
});

export const SurfaceKindSchema = z.enum(["floor", "wall", "ceiling", "other"]);

export const SurfaceSchema = z.looseObject({
  id: IdSchema,
  kind: SurfaceKindSchema,
  roomId: IdSchema.optional(),
  elementId: IdSchema.optional(),
  nodeRefs: z.array(NodeRefSchema).min(1),
  defaultColor: ColorSchema,
  role: z.string().optional(),
});

export const SourceSchema = z.looseObject({
  id: IdSchema,
  label: z.string(),
  description: z.string(),
  path: z.string().optional(),
  originalPath: z.string().optional(),
  includedInPackage: z.boolean().optional(),
  bytes: z.number().int().optional(),
  modified: z.string().optional(),
  sha256: z.string().optional(),
});

export const IssueSeveritySchema = z.enum(["info", "low", "medium", "high"]);

export const IssueSchema = z.looseObject({
  id: IdSchema,
  severity: IssueSeveritySchema,
  description: z.string(),
  /** The ids this issue is about; the inspector uses it to surface uncertainty in context. */
  affects: z.array(IdSchema).default([]),
});

export const ManifestSchema = z.looseObject({
  schemaVersion: z.literal("1.0"),
  modelId: IdSchema,
  name: z.string().optional(),
  generated: z.string().optional(),
  generator: z.string().optional(),
  coordinateSystem: CoordinateSystemSchema,
  bounds: BoundsSchema,
  buildings: z.array(BuildingSchema).min(1),
  floors: z.array(FloorSchema).min(1),
  rooms: z.array(RoomSchema),
  assets: z.array(AssetSchema).min(1),
  elements: z.array(ElementSchema),
  surfaces: z.array(SurfaceSchema),
  sources: z.array(SourceSchema),
  issues: z.array(IssueSchema),
  conventions: z.looseObject({}).optional(),
});

/** Parse without throwing; the caller turns failure into a `SetupState`, never a blank canvas. */
export function safeParseManifest(input: unknown) {
  return ManifestSchema.safeParse(input);
}

/** Flatten a ZodError into the `path: message` lines the setup state shows. */
export function formatZodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}
