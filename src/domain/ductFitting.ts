export const DUCT_FITTINGS = ["silencer"] as const;
export type DuctFitting = (typeof DUCT_FITTINGS)[number];

export const DUCT_FITTING_LABELS: Record<DuctFitting, string> = {
  silencer: "Silencer",
};
