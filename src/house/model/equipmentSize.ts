import { z } from "zod";

export interface EquipmentSize {
  widthM: number;
  depthM: number;
  heightM: number;
}

export const DEFAULT_WOOD_STORAGE_SIZE: EquipmentSize = {
  widthM: 1,
  depthM: 2.5,
  heightM: 2.2,
};

export const EquipmentSizeSchema = z.object({
  widthM: z.number().finite().min(0.1).max(20),
  depthM: z.number().finite().min(0.1).max(20),
  heightM: z.number().finite().min(0.1).max(10),
}).strict();

export function canonicalEquipmentSize(value: EquipmentSize): EquipmentSize {
  const mm = (number: number) => Math.round(number * 1000) / 1000;
  return { widthM: mm(value.widthM), depthM: mm(value.depthM), heightM: mm(value.heightM) };
}

export function equipmentSizeFromJson(value: string | null): EquipmentSize | null {
  if (!value) return null;
  try {
    const parsed = EquipmentSizeSchema.safeParse(JSON.parse(value));
    return parsed.success ? canonicalEquipmentSize(parsed.data) : null;
  } catch {
    return null;
  }
}
