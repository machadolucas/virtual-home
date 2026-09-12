"use client";

import { DocumentLink, DocumentThumbnail } from "@/features/documents/DocumentViewer";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  PROJECT_ATTACHMENT_ROLES,
  PROJECT_ATTACHMENT_ROLE_HELP as ROLE_HELP,
  PROJECT_ATTACHMENT_ROLE_LABEL as ROLE_LABEL,
  type ProjectAttachmentRole as Role,
} from "@/features/projects/labels";
import {
  addProjectAttachment,
  removeProjectAttachment,
} from "@/server/actions/infrastructure/projects";
import { useAction } from "@/features/settings/actionClient";
import type { ProjectAttachmentView } from "@/server/queries/infrastructure/projects";
import { Button, Field, Panel, Select } from "@/ui";

/**
 * Before/after photos and documents.
 *
 * Uploading and linking are two steps on purpose. `POST /api/upload` owns the file: it sniffs the
 * real type (never trusting the client), strips GPS from photos, dedupes by hash and writes outside
 * `public/`. This component only says what the file *is to this project* — and unlinking here
 * never deletes the file, because the same photo may also be a nameplate shot on a piece of
 * equipment.
 */
export function ProjectFiles({
  projectId,
  attachments,
}: {
  projectId: string;
  attachments: readonly ProjectAttachmentView[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [role, setRole] = useState<Role>("before");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const attach = useAction(addProjectAttachment, {
    successTitle: "File attached",
    onSuccess: () => router.refresh(),
  });
  const detach = useAction(removeProjectAttachment, {
    successTitle: "File detached",
    onSuccess: () => router.refresh(),
  });

  const upload = async (file: File): Promise<void> => {
    setUploadError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/upload", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          details?: { message?: string };
          error?: string;
        };
        setUploadError(body.details?.message ?? body.error ?? `Upload failed (${res.status}).`);
        return;
      }
      const stored = (await res.json()) as { id: string };
      attach.run({ projectId, attachmentId: stored.id, role });
    } catch {
      setUploadError("The upload did not reach the server. Nothing was attached.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const grouped = PROJECT_ATTACHMENT_ROLES.map((r) => ({
    role: r,
    files: attachments.filter((a) => a.role === r),
  }));
  const unroled = attachments.filter(
    (a) => a.role === null || !PROJECT_ATTACHMENT_ROLES.includes(a.role as Role),
  );

  return (
    <Panel
      title="Photos and documents"
      subtitle="Household files, served only to signed-in members — never from a public folder."
      footer={
        uploadError ?? attach.error ? (
          <span role="alert" className="text-overdue">
            {uploadError ?? attach.error}
          </span>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {grouped.map(({ role: r, files }) =>
          files.length === 0 ? null : (
            <section key={r} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
                {ROLE_LABEL[r]}
              </h3>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {files.map((file) => (
                  <li key={`${file.attachmentId}-${r}`} className="flex flex-col gap-1">
                    <DocumentLink document={{id:file.attachmentId, originalFilename:file.originalFilename, caption:file.caption, mime:file.mime}}
                      className="block overflow-hidden rounded-md border border-line"
                    >
                      {file.mime.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element -- private authed route, no loader
                        <img
                          src={`/api/attachments/${file.attachmentId}?v=web`}
                          alt={file.caption ?? file.originalFilename}
                          className="aspect-[4/3] w-full object-cover"
                        />
                      ) : (
                        <DocumentThumbnail document={{id:file.attachmentId,mime:file.mime,originalFilename:file.originalFilename}} />
                      )}
                    </DocumentLink>
                    <span className="truncate text-xs text-ink-3">{file.originalFilename}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={detach.pending}
                      onClick={() =>
                        detach.run({ projectId, attachmentId: file.attachmentId, role: r })
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}

        {unroled.length > 0 ? (
          <p className="text-xs text-ink-3">
            {unroled.length} more {unroled.length === 1 ? "file" : "files"} attached with a role
            this screen does not use.
          </p>
        ) : null}

        {attachments.length === 0 ? (
          <p className="text-sm text-ink-2">No files yet.</p>
        ) : null}

        <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
          <Field label="Attach as" help={ROLE_HELP[role]}>
            {({ id }) => (
              <Select
                id={id}
                value={role}
                onValueChange={(v) => setRole(v as Role)}
                options={PROJECT_ATTACHMENT_ROLES.map((r) => ({
                  value: r,
                  label: ROLE_LABEL[r],
                }))}
              />
            )}
          </Field>
          <Field label="File" help="Photos, PDFs and scans. Up to the configured upload limit.">
            {({ id }) => (
              <input
                id={id}
                ref={inputRef}
                type="file"
                disabled={uploading || attach.pending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
                className="block w-full text-sm file:mr-3 file:min-h-9 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-3 file:text-sm"
              />
            )}
          </Field>
        </div>
      </div>
    </Panel>
  );
}
