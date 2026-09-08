"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BellOff, BellRing, Plus, Trash2 } from "lucide-react";
import { Avatar, Badge, Button, Dialog, Field, IconButton, Input, Select } from "@/ui";
import { isNotifyService } from "@/features/settings/notify";
import { useAction } from "@/features/settings/actionClient";
import {
  addNotifyDevice,
  removeNotifyDevice,
  setNotifyDeviceActive,
  updateDisplayColor,
} from "@/server/actions/settings/household";

const TYPE_IT = "__manual";

export interface NotifyCandidateView {
  notifyService: string;
  label: string;
  haDeviceName: string;
  model: string | null;
}

/**
 * The display-colour editor.
 *
 * A colour is the only profile field a browser may change, because it is the only one that grants
 * nothing: it tints avatars and attribution chips, and a bad value is rejected before it reaches
 * CSS. Names, usernames and passwords all need machine access (`pnpm vh-admin`).
 */
export function ColorEditor({
  userId,
  userName,
  color,
}: {
  userId: string;
  userName: string;
  color: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(color ?? "#2f5fd0");

  const call = useAction(updateDisplayColor, {
    successTitle: "Colour saved",
    onSuccess: () => router.refresh(),
  });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field
        label={`Display colour for ${userName}`}
        help="Shown at about a fifth of its strength behind ink-coloured initials, so any hue stays readable."
        className="min-w-52"
      >
        {({ id, describedBy }) => (
          <div className="flex items-center gap-2">
            <input
              id={id}
              type="color"
              aria-describedby={describedBy}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="h-11 w-14 shrink-0 cursor-pointer rounded-sm border border-line-strong bg-surface-2 p-1"
            />
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value.toLowerCase())}
              aria-label={`Display colour for ${userName} as a hex value`}
              className="w-28 font-mono"
              maxLength={7}
            />
            <Avatar name={userName} color={value} size="md" labelled />
          </div>
        )}
      </Field>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={call.pending}
          disabled={!/^#[0-9a-f]{6}$/.test(value)}
          onClick={() => call.run({ userId, displayColor: value })}
        >
          Save colour
        </Button>
        {color === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            disabled={call.pending}
            onClick={() => call.run({ userId, displayColor: null })}
          >
            Use the default
          </Button>
        )}
      </div>
      {call.error === null ? null : (
        <p role="alert" className="w-full text-sm font-medium text-overdue">
          {call.error}
        </p>
      )}
    </div>
  );
}

/**
 * Add a notify device.
 *
 * The candidate list is **derived, not discovered**: the registry cache holds identities, not Home
 * Assistant's service registry, so a phone registered by the companion app is turned into
 * `notify.mobile_app_<slug>` by HA's own slug rules. That is a good guess and a bad promise, so
 * typing the service name by hand is always available — and getting it wrong fails loudly in the
 * notification outbox rather than silently.
 */
export function AddDeviceDialog({
  userId,
  userName,
  candidates,
}: {
  userId: string;
  userName: string;
  candidates: readonly NotifyCandidateView[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(candidates[0]?.notifyService ?? TYPE_IT);
  const [manualService, setManualService] = useState("");
  const [label, setLabel] = useState(candidates[0]?.label ?? "");

  const call = useAction(addNotifyDevice, {
    successTitle: "Device added",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const manual = choice === TYPE_IT;
  const selected = candidates.find((entry) => entry.notifyService === choice);
  const notifyService = manual ? manualService.trim() : choice;
  const valid = isNotifyService(notifyService) && label.trim() !== "";

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" size="sm" icon={<Plus aria-hidden="true" />}>
          Add a device
        </Button>
      }
      title={`Add a device for ${userName}`}
      description="A notification service that reaches one phone. One service reaches one person, so registering it twice is refused."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={!valid}
            onClick={() =>
              call.run({
                userId,
                label,
                notifyService,
                haDeviceName: selected?.haDeviceName ?? null,
              })
            }
          >
            Add it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Which phone"
          required
          help={
            candidates.length === 0
              ? "No phone was found in the registry cache. Either the companion app is not set up, or the worker has not synced yet — type the service name instead."
              : "These are worked out from the phones the Home Assistant companion app registered. Check the name matches what Home Assistant shows under Developer Tools → Actions."
          }
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              describedBy={describedBy}
              value={choice}
              onValueChange={(value) => {
                setChoice(value);
                const match = candidates.find((entry) => entry.notifyService === value);
                if (match !== undefined) setLabel(match.label);
              }}
              options={[
                ...candidates.map((entry) => ({
                  value: entry.notifyService,
                  label: entry.label,
                  hint: `${entry.notifyService}${entry.model === null ? "" : ` · ${entry.model}`}`,
                })),
                { value: TYPE_IT, label: "Type the service name myself" },
              ]}
            />
          )}
        </Field>

        {manual ? (
          <Field
            label="Notification service"
            required
            help="As Home Assistant spells it: notify.mobile_app_my_phone"
            error={
              manualService !== "" && !isNotifyService(manualService)
                ? "Expected something like notify.mobile_app_my_phone — lowercase letters, digits and underscores."
                : undefined
            }
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                className="font-mono"
                value={manualService}
                onChange={(event) => setManualService(event.target.value.trim().toLowerCase())}
                placeholder="notify.mobile_app_…"
              />
            )}
          </Field>
        ) : (
          <p className="font-mono text-xs text-ink-3">{choice}</p>
        )}

        <Field label="Label" required help="How this device is named in the settings list.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Lucas iPhone"
            />
          )}
        </Field>

        <p className="text-xs leading-5 text-ink-3">
          Nothing is sent to check the name. If it is wrong, the first reminder fails and says so
          under Settings → System, with the error Home Assistant returned.
        </p>

        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function DeviceRow({
  device,
}: {
  device: {
    id: string;
    label: string;
    notifyService: string;
    haDeviceName: string | null;
    isActive: boolean;
  };
}) {
  const router = useRouter();
  const toggle = useAction(setNotifyDeviceActive, { onSuccess: () => router.refresh() });
  const remove = useAction(removeNotifyDevice, {
    successTitle: "Device removed",
    onSuccess: () => router.refresh(),
  });

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <span className="text-sm font-medium text-ink">{device.label}</span>
      <span className="font-mono text-xs text-ink-3">{device.notifyService}</span>
      {device.isActive ? null : <Badge tone="neutral" size="sm">Muted</Badge>}
      {device.haDeviceName === null ? null : (
        <span className="text-xs text-ink-3">device name “{device.haDeviceName}”</span>
      )}
      <span className="ml-auto flex items-center gap-1">
        <IconButton
          label={device.isActive ? `Mute ${device.label}` : `Unmute ${device.label}`}
          variant="ghost"
          size="sm"
          loading={toggle.pending}
          icon={
            device.isActive ? <BellRing aria-hidden="true" /> : <BellOff aria-hidden="true" />
          }
          onClick={() => toggle.run({ deviceId: device.id, isActive: !device.isActive })}
        />
        <IconButton
          label={`Remove ${device.label}`}
          variant="ghost"
          size="sm"
          loading={remove.pending}
          icon={<Trash2 aria-hidden="true" />}
          onClick={() => remove.run({ deviceId: device.id })}
        />
      </span>
    </li>
  );
}
