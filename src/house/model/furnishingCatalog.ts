import type { FurnishingKind } from "./types";

export const FURNISHING_CATALOG: Array<{ kind: FurnishingKind; label: string; size: [number, number, number] }> = [
  { kind: "sofa", label: "Sofa", size: [2.1,.9,.85] },
  { kind: "sofa_l", label: "L-shaped sofa", size: [2.6,1.7,.85] },
  { kind: "bed_single", label: "Single bed", size: [.9,2,.6] },
  { kind: "bed_double", label: "Double bed", size: [1.6,2,.6] },
  { kind: "bedside_table", label: "Bedside table", size: [.5,.45,.55] },
  { kind: "chair", label: "Chair", size: [.5,.55,.9] },
  { kind: "dining_table", label: "Dining table", size: [1.8,.9,.75] },
  { kind: "computer_desk", label: "Computer desk", size: [1.4,.7,.75] },
  { kind: "bicycle", label: "Bicycle", size: [1.7,.45,1.1] },
  { kind: "shelves", label: "Shelves", size: [1,.35,1.8] },
  { kind: "cabinet", label: "Cabinet / wardrobe", size: [1.2,.6,2] },
  { kind: "kitchen_counter", label: "Kitchen counter", size: [1.8,.65,.92] },
  { kind: "rug", label: "Rug", size: [2,1.4,.02] },
  { kind: "bench", label: "Bench", size: [1.3,.45,.5] },
];
