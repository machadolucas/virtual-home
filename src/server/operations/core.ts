import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

/** Authentication belongs to the transport. Services receive only the verified actor identity. */
export interface OperationActor { user: { id: string } }
export interface Operation<I extends z.ZodType, O> {
  input: I;
  execute: (value: z.output<I>, actor: OperationActor) => O;
}

export function defineOperation<I extends z.ZodType, O>(
  input: I,
  execute: (value: z.output<I>, actor: OperationActor) => O,
): Operation<I, O> { return { input, execute }; }

const invalidations = new AsyncLocalStorage<Set<string>>();

/** Domain writes describe affected screens; their transport invalidates only after commit. */
export function revalidatePath(path: string): void { invalidations.getStore()?.add(path); }

export function runOperation<I extends z.ZodType, O>(
  operation: Operation<I, O>, raw: unknown, actor: OperationActor,
): { data: O; paths: string[] } {
  const paths = new Set<string>();
  const data = invalidations.run(paths, () => operation.execute(operation.input.parse(raw), actor));
  if (data instanceof Promise) throw new Error("Application operations must be synchronous");
  return { data, paths: [...paths] };
}
