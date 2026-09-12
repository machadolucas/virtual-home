"use client";
import type { Route } from "next";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProjectLinkEntityKind } from "@/db/schema/infrastructure";
import { PROJECT_LINK_KINDS } from "@/features/projects/wire";
import { PROJECT_LINK_LABEL } from "@/features/projects/labels";
import { useAction } from "@/features/settings/actionClient";
import { RecordPicker } from "@/features/projects/RecordPicker";
import type { ProjectLinkView } from "@/server/queries/infrastructure/projects";
import { addProjectLink, removeProjectLink } from "@/server/actions/infrastructure/projects";
import { Badge, Button, Field, Input, Panel, Select } from "@/ui";

/**
 * What this project touched.
 *
 * Existence is validated on the server before the row is written, because `project_link` is
 * polymorphic and SQLite cannot declare the foreign key. A link whose target has since disappeared
 * shows as **missing** with its raw id, rather than as a plausible-looking name — a dangling link
 * the UI hides is a dangling link nobody ever fixes.
 *
 * Every kind uses a paginated record search so linking never requires a database id.
 */
export function ProjectLinks({
  projectId,
  links,
}: {
  projectId: string;
  links: readonly ProjectLinkView[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState<ProjectLinkEntityKind>("asset");
  const [entityId, setEntityId] = useState("");
  const [role, setRole] = useState("");

  const add = useAction(addProjectLink, {
    successTitle: "Linked",
    messages: {
      link_exists: "That is already linked to this project.",
      not_found: "Nothing with that id exists, so the link was not created.",
    },
    onSuccess: () => {
      setEntityId("");
      setRole("");
      router.refresh();
    },
  });
  const remove = useAction(removeProjectLink, {
    successTitle: "Unlinked",
    onSuccess: () => router.refresh(),
  });


  return (
    <Panel
      title="Links"
      subtitle="Nothing here is created by the project — these point at records that already exist."
      footer={
        add.error ? (
          <span role="alert" className="text-overdue">
            {add.error}
          </span>
        ) : null
      }
    >
      {links.length === 0 ? (
        <p className="text-sm text-ink-2">Nothing linked yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {links.map((link) => (
            <li key={link.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {link.label === null ? (
                    <span className="text-ink-2">
                      <Badge tone="overdue">Missing</Badge>{" "}
                      <code className="text-xs">{link.entityId}</code>
                    </span>
                  ) : link.href ? (
                    <Link href={(link.href) as Route} className="hover:underline">
                      {link.label}
                    </Link>
                  ) : (
                    link.label
                  )}
                </p>
                <p className="text-xs text-ink-3">
                  {PROJECT_LINK_LABEL[link.entityKind]}
                  {link.role ? ` · ${link.role}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                loading={remove.pending}
                onClick={() => remove.run({ linkId: link.id })}
              >
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-4 flex flex-col gap-3 border-t border-line pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (entityId.trim() === "") return;
          add.run({
            projectId,
            entityKind: kind,
            entityId: entityId.trim(),
            role: role.trim() === "" ? null : role.trim(),
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="What kind">
            {({ id }) => (
              <Select
                id={id}
                value={kind}
                onValueChange={(v) => {
                  setKind(v as ProjectLinkEntityKind);
                  setEntityId("");
                }}
                options={PROJECT_LINK_KINDS.map((k) => ({
                  value: k,
                  label: PROJECT_LINK_LABEL[k],
                }))}
              />
            )}
          </Field>
          <Field label="Which record">{({ id }) => <RecordPicker key={kind} id={id} kind={kind} value={entityId} onChange={setEntityId} />}</Field>
          <Field label="Role" help="Optional: “replaced”, “inspected”, “paid for”.">
            {({ id }) => (
              <Input
                id={id}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                maxLength={60}
              />
            )}
          </Field>
        </div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="self-start"
          loading={add.pending}
          disabled={entityId.trim() === ""}
        >
          Add link
        </Button>
      </form>
    </Panel>
  );
}
