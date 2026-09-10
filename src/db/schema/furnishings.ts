/** Lightweight, model-only objects drawn in the house workspace. */
import { sql } from "drizzle-orm";
import { check, index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { auditQuad, oneOf, positive } from "./columns";

export const FURNISHING_KINDS = [
  "sofa",
  "sofa_l",
  "bed_single",
  "bed_double",
  "bedside_table",
  "chair",
  "dining_table",
  "computer_desk",
  "bicycle",
  "shelves",
  "cabinet",
  "kitchen_counter",
  "rug",
  "bench",
] as const;
export type FurnishingKind = (typeof FURNISHING_KINDS)[number];

export const furnishing = sqliteTable(
  "furnishing",
  {
    id: text("id").primaryKey(),
    /** Stable package model id. Semantic node ids are revalidated on every read/write. */
    modelId: text("model_id").notNull(),
    /** Room id when the point is inside one; otherwise its floor id. */
    modelNodeId: text("model_node_id").notNull(),
    floorId: text("floor_id").notNull(),
    roomId: text("room_id"),
    kind: text("kind").$type<FurnishingKind>().notNull(),
    name: text("name").notNull(),
    /** Physical site metres; the position is the centre of the footprint at floor level. */
    posX: real("pos_x").notNull(),
    posY: real("pos_y").notNull(),
    posZ: real("pos_z").notNull(),
    rotYawDeg: real("rot_yaw_deg").notNull().default(0),
    widthM: real("width_m").notNull(),
    depthM: real("depth_m").notNull(),
    heightM: real("height_m").notNull(),
    ...auditQuad(),
  },
  (t) => [
    check("ck_furnishing_kind", oneOf("kind", FURNISHING_KINDS)),
    check("ck_furnishing_width", positive("width_m")),
    check("ck_furnishing_depth", positive("depth_m")),
    check("ck_furnishing_height", positive("height_m")),
    check("ck_furnishing_finite", sql`${t.posX} = ${t.posX} AND ${t.posY} = ${t.posY} AND ${t.posZ} = ${t.posZ}`),
    index("ix_furnishing_model_floor").on(t.modelId, t.floorId),
    index("ix_furnishing_node").on(t.modelId, t.modelNodeId),
  ],
);
