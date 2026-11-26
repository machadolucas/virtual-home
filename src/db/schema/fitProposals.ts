import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { FitDraft } from "@/house/model/fitProposal";
import { createdPair } from "./columns";

export const fitProposal = sqliteTable(
  "fit_proposal",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    roomId: text("room_id").notNull(),
    draft: text("draft_json", { mode: "json" }).$type<FitDraft>().notNull(),
    requestId: text("request_id").notNull(),
    ...createdPair(),
  },
  (t) => [
    uniqueIndex("ux_fit_proposal_request").on(t.createdBy, t.requestId),
    index("ix_fit_proposal_room").on(t.modelId, t.fingerprint, t.roomId, t.createdAtMs),
  ],
);
