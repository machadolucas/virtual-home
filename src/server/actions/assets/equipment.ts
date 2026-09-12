"use server";

import { bindOperation } from "@/server/operations/web";
import * as operations from "@/server/operations/assets/equipment";

export const createEquipment = bindOperation(operations.createEquipment, false);
export const updateEquipment = bindOperation(operations.updateEquipment, false);
export const setConsumables = bindOperation(operations.setConsumables, false);
export const retireEquipment = bindOperation(operations.retireEquipment, false);
export const replaceEquipment = bindOperation(operations.replaceEquipment, false);
