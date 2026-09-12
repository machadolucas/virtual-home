import "server-only";
import { revalidatePath } from "next/cache";

// Validation and error mapping are canonical application-service helpers.
export {toHttpError,invalid,domainCall,localDate,id,idempotencyKey,reason,optionalReason,optionalNote,qtyMilli,positiveQtyMilli,minutes} from "@/server/operations/maintenance/shared";

/** Browser-only adapter for actions that have not moved to the operation boundary. */
export function revalidateMaintenance(occurrenceId?:string,planId?:string):void {
  revalidatePath("/today");
  revalidatePath("/history");
  revalidatePath("/plans");
  if(occurrenceId!==undefined)revalidatePath(`/tasks/${occurrenceId}`);
  if(planId!==undefined)revalidatePath(`/plans/${planId}`);
}
