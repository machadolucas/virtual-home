"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getDb, writeTx } from "@/db/client";
import { action } from "@/server/api/action";
import { changeHaReview } from "@/server/services/haReview";
export const setHaIgnored = action(z.object({ targets: z.array(z.object({ kind: z.enum(["device", "entity"]), registryId: z.string().min(1).max(300) })).min(1).max(1000), ignored: z.boolean() }), (input, session) => {
  const targets = writeTx(getDb().db, tx => changeHaReview(tx, session.user.id, input.targets, input.ignored));
  revalidatePath("/settings/home-assistant"); revalidatePath("/equipment");
  return { targets, ignored: input.ignored };
});
