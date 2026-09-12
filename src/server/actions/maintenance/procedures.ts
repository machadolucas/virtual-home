"use server";

import { bindOperation } from "@/server/operations/web";
import * as operations from "@/server/operations/maintenance/procedures";

export const createProcedure = bindOperation(operations.createProcedure, false);
export const saveProcedureDraft = bindOperation(operations.saveProcedureDraft, false);
export const publishProcedureDraft = bindOperation(operations.publishProcedureDraft, false);
export const startProcedureDraft = bindOperation(operations.startProcedureDraft, false);
export const discardProcedureDraft = bindOperation(operations.discardProcedureDraft, true);
