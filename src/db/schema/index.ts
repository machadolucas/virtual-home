// Barrel for all Drizzle tables. Each module file exports its tables; keep this list complete
// so drizzle-kit and the runtime `schema` object see everything.
//
// It is also the object handed to Better Auth's Drizzle adapter, which addresses tables by the key
// they are exported under — so never rename an export from `./auth`.
//
// `./columns` is deliberately NOT re-exported: it holds column/CHECK helpers, not tables.
export * from "./auth";
export * from "./household";
export * from "./model";
export * from "./furnishings";
export * from "./assets";
export * from "./procedures";
export * from "./maintenance";
export * from "./inventory";
export * from "./infrastructure";
export * from "./ha";
export * from "./notifications";
export * from "./attachments";
export * from "./system";

export * from "./mcp";
export * from "./documentText";
export * from "./integrity";
