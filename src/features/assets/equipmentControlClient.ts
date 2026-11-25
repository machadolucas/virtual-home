import type { HaControlCommand } from "@/domain/haControl";

const ERROR_LABELS: Record<string, string> = {
  ha_disconnected: "Home Assistant is disconnected. Try again when it reconnects.",
  entity_unavailable: "This entity is unavailable in Home Assistant.",
  unsupported_capability: "This device no longer supports that setting. Refresh its controls.",
  ha_timeout: "Home Assistant did not confirm the command. Refresh the device state before retrying.",
  result_unknown: "The command result is uncertain. Refresh the device state before retrying.",
  control_result_unknown: "The command result is uncertain. Refresh the device state before retrying.",
  ha_rejected: "Home Assistant rejected the command. Check the device and try again.",
  control_entity_unlinked: "This entity is no longer linked to the equipment. Refresh its controls.",
  control_entity_disabled: "This entity is disabled in Home Assistant. Refresh its controls.",
  control_capability_changed: "The device capabilities changed. Refresh its controls before trying again.",
  control_entity_missing: "This entity is no longer available. Refresh its controls.",
  control_entity_changed: "The entity changed before the command could be sent. Refresh its controls.",
  control_expired: "The command expired before it could be sent. Nothing was sent.",
  expired: "The command expired before it could be sent. Nothing was sent.",
};

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(ERROR_LABELS[body.error] ?? body.message ?? body.hint ?? "Could not contact Home Assistant. Refresh and try again.");
  return body as T;
}

export async function sendEquipmentCommand(base: string, registryId: string, command: HaControlCommand, alive: () => boolean) {
  const queued = await request<{ commandId: string; status: string }>(base, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), registryId, command }),
  });
  const deadline = Date.now() + 35_000;
  let status = queued.status;
  while ((status === "queued" || status === "sending") && Date.now() < deadline && alive()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!alive()) return;
    const receipt = await request<{ status: string; error?: string | null }>(`${base}/${encodeURIComponent(queued.commandId)}`);
    status = receipt.status;
    if (status === "failed" || status === "expired") throw new Error(ERROR_LABELS[receipt.error ?? status] ?? receipt.error ?? "Home Assistant could not complete the command.");
  }
  if (!alive()) return;
  if (status !== "sent") throw new Error("The result is not confirmed yet. Refresh the state before trying again.");
}
