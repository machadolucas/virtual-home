"use server";

import { bindOperation } from "@/server/operations/web";
import * as operations from "@/server/operations/inventory/parts";

export const createPart = bindOperation(operations.createPart, false);
export const updatePart = bindOperation(operations.updatePart, false);
export const setKitComponents = bindOperation(operations.setKitComponents, false);
export const upsertSupplier = bindOperation(operations.upsertSupplier, false);
export const removeSupplier = bindOperation(operations.removeSupplier, false);
export const upsertLot = bindOperation(operations.upsertLot, false);
export const setPartArchived = bindOperation(operations.setPartArchived, false);
export const findPartByProductCode = bindOperation(operations.findPartByProductCode, false);
