"use server";

import { bindOperation } from "@/server/operations/web";
import * as operations from "@/server/operations/inventory/stock";

export const addPurchase = bindOperation(operations.addPurchase, false);
export const stockTake = bindOperation(operations.stockTake, false);
export const explodeKit = bindOperation(operations.explodeKit, false);
export const undoExplode = bindOperation(operations.undoExplode, false);
export const correctTransaction = bindOperation(operations.correctTransaction, false);
export const setEstimate = bindOperation(operations.setEstimate, false);
