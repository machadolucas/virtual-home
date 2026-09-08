/**
 * The shared domain layer: pure scheduling logic plus the transactional steps the web and worker
 * processes both call. Nothing here reads the system clock or the process time zone — every entry
 * point takes an injected `Clock` and the household zone.
 */
export * from "./errors";
export * from "./time";
export * from "./recurrence";
export * from "./occurrence";
export * from "./notify";
