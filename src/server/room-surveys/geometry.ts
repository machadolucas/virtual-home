import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db/client";
import { roomSurveyGeometry, roomSurveyGeometryChunk } from "@/db/schema";
import type { Vec3 } from "@/house/model/types";
import type { RoomSurveyGeometry, RoomSurveyGeometryMetadata, roomSurveyGeometryPageInput } from "@/house/roomSurveyTypes";
import { notFound } from "@/server/api/handler";

const sizes = { points: 2000, indices: 6000 } as const;
const chunks = roomSurveyGeometryChunk;

export function prepareSurveyGeometry(surveyId: string, geometry: RoomSurveyGeometry) {
  const rows: (typeof chunks.$inferInsert)[] = [];
  const surfaces = geometry.surfaces.map(({ points, indices, ...meta }, surface) => {
    for (const [section, values] of [["points", points], ["indices", indices ?? []]] as const) {
      const size = sizes[section];
      for (let offset = 0; offset < values.length; offset += size) {
        rows.push({ surveyId, surface, section, chunk: offset / size, payload: values.slice(offset, offset + size) });
      }
    }
    return { ...meta, pointCount: points.length, indexCount: indices?.length ?? 0 };
  });
  const metadata: RoomSurveyGeometryMetadata = { scope: geometry.scope, surfaces, measurements: geometry.measurements };
  return { metadata, rows };
}

export function insertSurveyGeometry(db: Db, surveyId: string, prepared: ReturnType<typeof prepareSurveyGeometry>) {
  db.insert(roomSurveyGeometry).values({ surveyId, metadata: prepared.metadata }).run();
  for (let i = 0; i < prepared.rows.length; i += 32) db.insert(chunks).values(prepared.rows.slice(i, i + 32)).run();
}

export function readGeometryMetadata(db: Db, id: string) {
  const record = db.select({ metadata: roomSurveyGeometry.metadata }).from(roomSurveyGeometry)
    .where(eq(roomSurveyGeometry.surveyId, id)).get();
  if (!record) throw notFound("room_survey_geometry_missing");
  return record.metadata;
}

export function readSurveyGeometry(db: Db, id: string): RoomSurveyGeometry {
  const { surfaces, ...metadata } = readGeometryMetadata(db, id);
  const assembled = surfaces.map(({ source, label, orientation, indexCount }) => ({
    source, label, orientation, points: [] as Vec3[], ...(indexCount ? { indices: [] as number[] } : {}),
  }));
  const rows = db.select().from(chunks).where(eq(chunks.surveyId, id)).orderBy(chunks.surface, chunks.section, chunks.chunk).all();
  for (const row of rows) {
    const surface = assembled[row.surface];
    if (!surface) throw new Error("Room survey contains a chunk with no surface metadata");
    if (row.section === "points") surface.points.push(...row.payload as Vec3[]);
    else surface.indices?.push(...row.payload as number[]);
  }
  return { ...metadata, surfaces: assembled };
}

export function readGeometryPage(db: Db, input: z.output<typeof roomSurveyGeometryPageInput>) {
  const { id, surface, section, offset, limit } = input;
  const metadata = readGeometryMetadata(db, id).surfaces[surface];
  if (!metadata) throw notFound("unknown_room_survey_surface");
  const total = section === "points" ? metadata.pointCount : metadata.indexCount;
  const values: (number | Vec3)[] = [];
  if (offset < total) {
    const size = sizes[section];
    const rows = db.select({ payload: chunks.payload, chunk: chunks.chunk }).from(chunks)
      .where(and(eq(chunks.surveyId, id), eq(chunks.surface, surface), eq(chunks.section, section),
        gte(chunks.chunk, Math.floor(offset / size)),
        lte(chunks.chunk, Math.floor((Math.min(total, offset + limit) - 1) / size)),
      )).orderBy(chunks.chunk).all();
    for (const { payload, chunk } of rows) {
      const start = chunk * size;
      values.push(...payload.slice(Math.max(0, offset - start), offset + limit - start));
    }
  }
  return {
    id, surface, section, source: metadata.source, label: metadata.label, total,
    values, nextOffset: offset + limit < total ? offset + limit : null,
  };
}
