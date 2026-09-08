"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Link2, Link2Off, Plus, Wand2 } from "lucide-react";
import { HA_LINK_ROLES, type HaLinkRole } from "@/db/schema";
import { Badge, Button, Dialog, Field, IconButton, Select, Textarea } from "@/ui";
import { HA_LINK_ROLE_HELP, HA_LINK_ROLE_LABEL, LINK_STATE_META } from "@/features/assets/labels";
import type { RelinkSuggestion } from "@/features/assets/haLink";
import { useAction } from "@/features/settings/actionClient";
import {
  linkHaEntity,
  relinkHa,
  setHaLinkState,
  unlinkHa,
} from "@/server/actions/assets/haLinks";

export interface LinkRow {
  id: string;
  linkKind: "device" | "entity";
  role: HaLinkRole;
  linkState: keyof typeof LINK_STATE_META;
  entityId: string | null;
  entityIdSnapshot: string | null;
  haDeviceName: string | null;
  haEntityRegistryId: string | null;
  state: string | null;
  unitOfMeasurement: string | null;
  notes: string | null;
}

export interface EntityOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * The Home Assistant links of one unit, with the buttons that repair them.
 *
 * The state badges are the point. `renamed` is not an error — every link stores the registry id,
 * so a rename in HA breaks nothing and only the label we cached is stale. `missing` *is* an error,
 * and it is the only state a relink can fix. Making those two look the same would train people to
 * ignore both.
 */
export function LinksPanel({
  assetId,
  links,
  suggestions,
  entityOptions,
}: {
  assetId: string;
  links: readonly LinkRow[];
  suggestions: readonly RelinkSuggestion[];
  entityOptions: readonly EntityOption[];
}) {
  return (
    <div className="flex flex-col gap-4">
      {links.length === 0 ? (
        <p className="text-sm leading-6 text-ink-2">
          Not linked to Home Assistant — which is the normal case for most equipment. Nothing about
          scheduling or history needs a link; it only adds battery levels and live state.
        </p>
      ) : (
        <ul className="flex list-none flex-col divide-y divide-line">
          {links.map((link) => {
            const meta = LINK_STATE_META[link.linkState];
            // Every row's buttons otherwise read as the same three names to a screen reader, so a
            // links list is an undifferentiated "Retire this link, Remove this link, Retire this
            // link…". The entity id is what tells them apart on screen too.
            const subject =
              link.entityId ?? link.entityIdSnapshot ?? link.haDeviceName ?? "this link";
            const suggestion = suggestions.find((entry) => entry.linkId === link.id);
            return (
              <li key={link.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral" size="sm">
                    {HA_LINK_ROLE_LABEL[link.role]}
                  </Badge>
                  <span className="font-mono text-sm text-ink">
                    {link.entityId ?? link.entityIdSnapshot ?? link.haDeviceName ?? "—"}
                  </span>
                  {link.linkKind === "device" ? (
                    <Badge tone="neutral" size="sm">
                      Whole device
                    </Badge>
                  ) : null}
                  <Badge tone={meta.tone} size="sm">
                    {meta.label}
                  </Badge>
                  {link.state === null ? (
                    <span className="text-xs text-ink-3">no reading cached</span>
                  ) : (
                    <span className="vh-tnum text-xs text-ink-2">
                      {link.state}
                      {link.unitOfMeasurement === null ? "" : ` ${link.unitOfMeasurement}`}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    {link.linkState === "active" ? (
                      <SetStateButton
                        assetId={assetId}
                        linkId={link.id}
                        linkState="retired"
                        label={`Retire ${subject}`}
                      />
                    ) : link.linkState === "retired" ? (
                      <SetStateButton
                        assetId={assetId}
                        linkId={link.id}
                        linkState="active"
                        label={`Bring ${subject} back`}
                      />
                    ) : null}
                    <UnlinkButton assetId={assetId} linkId={link.id} subject={subject} />
                  </span>
                </div>

                <p className="max-w-prose text-xs leading-5 text-ink-3">{meta.explanation}</p>

                {link.entityIdSnapshot !== null &&
                link.entityId !== null &&
                link.entityIdSnapshot !== link.entityId ? (
                  <p className="text-xs leading-5 text-ink-3">
                    It was <span className="font-mono">{link.entityIdSnapshot}</span> when the link
                    was made.
                  </p>
                ) : null}

                {suggestion === undefined ? null : (
                  <RelinkRow assetId={assetId} suggestion={suggestion} />
                )}

                {link.notes === null ? null : (
                  <p className="text-xs leading-5 text-ink-3">{link.notes}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <AddLinkDialog assetId={assetId} entityOptions={entityOptions} />
        <span className="text-xs text-ink-3">
          A link is bound to the entity registry id, never to the entity id — so renaming it in
          Home Assistant changes nothing here.
        </span>
      </div>
    </div>
  );
}

function RelinkRow({
  assetId,
  suggestion,
}: {
  assetId: string;
  suggestion: RelinkSuggestion;
}) {
  const router = useRouter();
  const call = useAction(relinkHa, {
    successTitle: "Link repaired",
    onSuccess: () => router.refresh(),
  });

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Wand2 aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
        <span className="text-sm font-medium text-ink">
          Repoint at <span className="font-mono">{suggestion.entityId}</span>
        </span>
        <Badge tone={suggestion.confidence === "exact" ? "ok" : "neutral"} size="sm">
          {suggestion.confidence === "exact" ? "Almost certainly the same" : "Worth checking"}
        </Badge>
        <span className="ml-auto">
          <Button
            variant="secondary"
            size="sm"
            loading={call.pending}
            onClick={() =>
              call.run({ assetId, linkId: suggestion.linkId, registryId: suggestion.registryId })
            }
          >
            Repoint
          </Button>
        </span>
      </div>
      <p className="max-w-prose text-xs leading-5 text-ink-2">{suggestion.reason}</p>
      <p className="max-w-prose text-xs leading-5 text-ink-3">
        Nothing does this automatically: repointing claims two registry entries are the same
        physical device, and only you can say that.
      </p>
      {call.error === null ? null : (
        <p role="alert" className="text-xs font-medium text-overdue">
          {call.error}
        </p>
      )}
    </div>
  );
}

function SetStateButton({
  assetId,
  linkId,
  linkState,
  label,
}: {
  assetId: string;
  linkId: string;
  linkState: "active" | "retired";
  label: string;
}) {
  const router = useRouter();
  const call = useAction(setHaLinkState, { onSuccess: () => router.refresh() });
  return (
    <IconButton
      label={label}
      variant="ghost"
      size="sm"
      loading={call.pending}
      icon={
        linkState === "retired" ? (
          <Link2Off aria-hidden="true" />
        ) : (
          <Link2 aria-hidden="true" />
        )
      }
      onClick={() => call.run({ assetId, linkId, linkState })}
    />
  );
}

function UnlinkButton({
  assetId,
  linkId,
  subject,
}: {
  assetId: string;
  linkId: string;
  /** The entity this link points at, so one row's Remove is distinguishable from the next. */
  subject: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const call = useAction(unlinkHa, {
    successTitle: "Link removed",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <IconButton
          label={`Remove the link to ${subject}`}
          variant="ghost"
          size="sm"
          icon={<Link2Off aria-hidden="true" />}
        />
      }
      title="Remove this link?"
      description="Use this for a link created by mistake. To stop using a link that was once right, retire it instead — that keeps the record of what was connected."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={call.pending}
            onClick={() => call.run({ assetId, linkId })}
          >
            Remove it
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-ink-2">
        The removal itself is recorded in the audit trail, so the fact that a link once existed is
        not lost — only the link.
      </p>
      {call.error === null ? null : (
        <p role="alert" className="mt-3 text-sm font-medium text-overdue">
          {call.error}
        </p>
      )}
    </Dialog>
  );
}

function AddLinkDialog({
  assetId,
  entityOptions,
}: {
  assetId: string;
  entityOptions: readonly EntityOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [registryId, setRegistryId] = useState("");
  const [role, setRole] = useState<HaLinkRole>("primary");
  const [notes, setNotes] = useState("");

  const call = useAction(linkHaEntity, {
    successTitle: "Linked",
    onSuccess: () => {
      setOpen(false);
      setRegistryId("");
      router.refresh();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" size="sm" icon={<Plus aria-hidden="true" />}>
          Link an entity
        </Button>
      }
      title="Link a Home Assistant entity"
      description="Pick the entity and say what it is for. The role decides what the app does with it."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={registryId === ""}
            onClick={() => call.run({ assetId, registryId, role, notes })}
          >
            Link it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {entityOptions.length === 0 ? (
          <p className="text-sm leading-6 text-ink-2">
            The registry cache is empty, so there is nothing to pick from. That means the worker has
            not synced with Home Assistant yet — check Settings → Home Assistant.
          </p>
        ) : (
          <>
            <Field
              label="Entity"
              required
              help="Only entities that are live in the registry are listed. Diagnostic and disabled ones are left out."
            >
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  describedBy={describedBy}
                  value={registryId}
                  onValueChange={setRegistryId}
                  placeholder="Choose an entity…"
                  options={entityOptions}
                />
              )}
            </Field>

            <Field label="What it is for" required help={HA_LINK_ROLE_HELP[role]}>
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  describedBy={describedBy}
                  value={role}
                  onValueChange={(value) => setRole(value as HaLinkRole)}
                  options={HA_LINK_ROLES.map((entry) => ({
                    value: entry,
                    label: HA_LINK_ROLE_LABEL[entry],
                    hint: HA_LINK_ROLE_HELP[entry],
                  }))}
                />
              )}
            </Field>

            <Field label="Note">
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              )}
            </Field>
          </>
        )}

        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
