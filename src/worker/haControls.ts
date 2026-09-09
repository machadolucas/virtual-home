import type { DbHandle } from "@/db/client";
import {
  claimHaControlCommand,
  finishHaControlCommand,
  serviceCallForCommand,
} from "@/domain/haControlQueue";
import { log } from "@/server/log";
import {
  HaCommandTimeoutError,
  HaDisconnectedError,
  type HaSocket,
} from "@/worker/ha/socket";
import type { HaServiceTarget } from "@/worker/ha/protocol";
import { startIntervalJob, type Job } from "@/worker/jobs/interval";

export const HA_CONTROL_DRAIN_MS = 250;

export interface HaControlSocket {
  readonly state: string;
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: HaServiceTarget,
  ): Promise<unknown>;
}

export async function drainOneHaControlCommand(options: {
  handle: DbHandle;
  socket: HaControlSocket | null;
  now?: () => number;
  logger?: Pick<typeof log, "warn">;
}): Promise<boolean> {
  const now = options.now ?? Date.now;
  const command = claimHaControlCommand(options.handle, now());
  if (!command) return false;

  const socket = options.socket;
  if (!socket || socket.state !== "subscribed") {
    finishHaControlCommand(options.handle, command.id, now(), {
      sent: false,
      error: "ha_disconnected",
    });
    return true;
  }

  const call = serviceCallForCommand(command.command);
  try {
    await socket.callService(
      command.domain,
      call.service,
      call.serviceData,
      { entity_id: command.entityId },
    );
    finishHaControlCommand(options.handle, command.id, now(), { sent: true });
  } catch (err) {
    const error =
      err instanceof HaDisconnectedError
        ? "ha_disconnected"
        : err instanceof HaCommandTimeoutError
          ? "ha_timeout"
          : "ha_rejected";
    finishHaControlCommand(options.handle, command.id, now(), { sent: false, error });
    options.logger?.warn({ commandId: command.id, err }, "HA control command failed");
  }
  return true;
}

/** A single-flight drain: sliders use Apply, but multiple household tabs may still enqueue at once. */
export function startHaControlJob(options: {
  handle: DbHandle;
  socket: () => HaSocket | null;
  intervalMs?: number;
  now?: () => number;
}): Job {
  let running = false;
  return startIntervalJob({
    name: "ha_control",
    intervalMs: options.intervalMs ?? HA_CONTROL_DRAIN_MS,
    immediate: true,
    run: () => {
      if (running) return;
      running = true;
      void drainOneHaControlCommand({
        handle: options.handle,
        socket: options.socket(),
        now: options.now,
        logger: log,
      })
        .catch((err: unknown) => {
          log.warn({ err }, "HA control drain failed");
        })
        .finally(() => {
          running = false;
        });
    },
  });
}
