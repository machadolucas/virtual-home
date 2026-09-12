"use server";

import { bindOperation } from "@/server/operations/web";
import * as operations from "@/server/operations/assets/trash";

export const permanentlyDeleteEquipment = bindOperation(operations.permanentlyDeleteEquipment, true);
