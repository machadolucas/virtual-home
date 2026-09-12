"use client";

import { DocumentLink, DocumentThumbnail } from "@/features/documents/DocumentViewer";
/**
 * Manuals, nameplates and other documents on the equipment page's "Manuals & documents" panel.
 *
 * Private PDFs and images render in the app, with lazy thumbnails and a full viewer.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Trash2, Upload } from "lucide-react";
import { Button, Dialog, IconButton, Select } from "@/ui";
import { useAction } from "@/features/settings/actionClient";
import { linkAssetAttachment, unlinkAssetAttachment } from "@/server/actions/assets/attachments";
import { formatBytes } from "@/features/settings/format";
import {
  ASSET_ATTACHMENT_ROLE_LABEL,
  ASSET_DOCUMENT_ROLES,
  type AssetAttachmentRole,
} from "./labels";
import { AssetUploader } from "./AssetUploader";

export interface AssetDocument {
  id: string;
  originalFilename: string;
  caption: string | null;
  byteSize: number;
  role: string | null;
}

function isDocumentRole(value: string | null): value is (typeof ASSET_DOCUMENT_ROLES)[number] {
  return value !== null && (ASSET_DOCUMENT_ROLES as readonly string[]).includes(value);
}

export function AssetDocuments({
  assetId,
  documents,
}: {
  assetId: string;
  documents: readonly AssetDocument[];
}) {
  const router = useRouter();
  const [role, setRole] = useState<AssetAttachmentRole>("manual");
  const [removing, setRemoving] = useState<AssetDocument | null>(null);

  const link = useAction(linkAssetAttachment, {
    successTitle: "File attached",
    onSuccess: () => router.refresh(),
  });
  const unlink = useAction(unlinkAssetAttachment, {
    successTitle: "File removed. The file itself is kept.",
    onSuccess: () => {
      setRemoving(null);
      router.refresh();
    },
  });

  return (
    <div className="flex flex-col gap-3">
      {documents.length === 0 ? (
        <p className="text-sm leading-6 text-ink-2">
          Nothing attached. The manual and a photo of the nameplate are the two that save the most
          time later.
        </p>
      ) : (
        <ul className="flex list-none flex-col divide-y divide-line">
          {documents.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
              <DocumentLink document={doc} gallery={[...documents]}
                className="text-sm font-medium text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
              >
                <span className="mb-2 block w-40"><DocumentThumbnail document={doc} /></span>
                {doc.caption ?? doc.originalFilename}
              </DocumentLink>
              {isDocumentRole(doc.role) ? (
                <span className="text-xs text-ink-3">{ASSET_ATTACHMENT_ROLE_LABEL[doc.role]}</span>
              ) : null}
              <span className="vh-tnum text-xs text-ink-3">{formatBytes(doc.byteSize)}</span>
              <span className="ml-auto">
                <IconButton
                  label={`Remove ${doc.caption ?? doc.originalFilename}`}
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => setRemoving(doc)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Select
          ariaLabel="What kind of file this is"
          value={role}
          onValueChange={(value) => setRole(value as AssetAttachmentRole)}
          options={ASSET_DOCUMENT_ROLES.map((entry) => ({
            value: entry,
            label: ASSET_ATTACHMENT_ROLE_LABEL[entry],
          }))}
          selectSize="sm"
          className="w-40"
        />
        <AssetUploader
          accept="application/pdf,image/*"
          label="Add a file"
          icon={<Upload aria-hidden="true" />}
          inputLabel="Choose a manual, nameplate photo or other document"
          disabled={link.pending}
          onUploaded={(file) => link.run({ assetId, attachmentId: file.id, role })}
        />
      </div>

      {removing === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          size="sm"
          title="Remove this file?"
          description="The file itself is kept — only its link to this unit is removed."
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)} disabled={unlink.pending}>
                Keep it
              </Button>
              <Button
                variant="danger"
                loading={unlink.pending}
                onClick={() => unlink.run({ assetId, attachmentId: removing.id })}
              >
                Remove it
              </Button>
            </>
          }
        >
          {unlink.error === null ? null : (
            <p role="alert" className="text-sm font-medium text-overdue">
              {unlink.error}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
