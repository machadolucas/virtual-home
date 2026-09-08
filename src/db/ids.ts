/**
 * Identifier and clock helpers for the persistence layer.
 *
 * Every domain primary key is a UUIDv7 in lowercase dashed hex (CLAUDE.md): sortable by creation
 * time, type-compatible with Better Auth's TEXT ids, and generatable in-process so the web can
 * create rows without a round-trip.
 *
 * `nowMs()` exists so persistence-level code has one obvious spelling for "now". Domain logic that
 * needs a *testable* clock must take an injected `Clock` (see `src/domain/time.ts`) instead.
 */
import { v7 as uuidv7 } from "uuid";

/** A fresh UUIDv7, lowercase dashed hex. */
export function newId(): string {
  return uuidv7();
}

/** Current instant as an epoch-millisecond integer. */
export function nowMs(): number {
  return Date.now();
}
