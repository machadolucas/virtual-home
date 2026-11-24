/** Documented route operation and direction, independent of telemetry and geometry certainty. */
export const FLOW_DIRECTIONS = ["forward", "reverse", "unknown"] as const;
export const FLOW_BASES = ["declared", "inferred", "unknown"] as const;
export const FLOW_STATES = ["active", "inactive", "unknown"] as const;

export type FlowDirection = (typeof FLOW_DIRECTIONS)[number];
export type FlowBasis = (typeof FLOW_BASES)[number];
export type FlowState = (typeof FLOW_STATES)[number];
