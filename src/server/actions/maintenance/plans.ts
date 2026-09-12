"use server";

import { bindOperation } from "@/server/operations/web";
import * as operations from "@/server/operations/maintenance/plans";

export const createPlan = bindOperation(operations.createPlan, false);
export const updatePlan = bindOperation(operations.updatePlan, false);
export const seedPlan = bindOperation(operations.seedPlan, false);
export const cancelPlanAction = bindOperation(operations.cancelPlanAction, false);
export const generateNextOccurrence = bindOperation(operations.generateNextOccurrence, false);
export const previewSchedule = bindOperation(operations.previewSchedule, false);
