"use server";

import { bindOperation } from "@/server/operations/web";
import * as operations from "@/server/operations/maintenance/complete";

export const completeTask = bindOperation(operations.completeTask, false);
export const voidTaskCompletion = bindOperation(operations.voidTaskCompletion, false);
export const correctTaskCompletion = bindOperation(operations.correctTaskCompletion, false);
