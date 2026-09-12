import "server-only";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { action, freshAction } from "@/server/api/action";
import { runOperation, type Operation } from "./core";

/** Browser adapter retains session authorization, result shape and the established form APIs. */
export function bindOperation<I extends z.ZodType, O>(operation: Operation<I, O>, fresh = false) {
  return (fresh ? freshAction : action)(operation.input, (input, session) => {
    const result = runOperation(operation, input, session);
    for (const path of result.paths) revalidatePath(path);
    return result.data;
  });
}
