"use client";
/**
 * Adding a photo to a task, from a phone standing in front of the equipment.
 *
 * The bytes go to `/api/upload`, which is the only place a file enters the data directory: it
 * sniffs the real type, strips GPS, dedupes by hash and returns an attachment id. This component
 * then calls one server action to record the link. `capture="environment"` opens the rear camera
 * directly on iOS and Android instead of the photo library.
 */
import { useRef, useState } from "react";
import Image from "next/image";
import { Camera, Trash2, Upload } from "lucide-react";
import { Button, IconButton, Panel, toast } from "@/ui";
import { linkTaskPhoto, unlinkTaskPhoto } from "@/server/actions/maintenance/attachments";
import { useAction } from "./useAction";

export interface TaskPhotoView {
  linkId: string;
  attachmentId: string;
  caption: string | null;
  originalFilename: string;
  width: number | null;
  height: number | null;
  scope: "occurrence" | "completion";
}

export interface PhotoUploaderProps {
  occurrenceId: string;
  /** Where new photos attach: the open task, or the completion that closed it. */
  scope: "occurrence" | "completion";
  entityId: string;
  photos: readonly TaskPhotoView[];
  /** Closed tasks keep their photos but stop accepting new ones. */
  readOnly?: boolean;
}

const ACCEPT = "image/jpeg,image/png,image/webp";

export function PhotoUploader({
  occurrenceId,
  scope,
  entityId,
  photos,
  readOnly = false,
}: PhotoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const link = useAction(linkTaskPhoto, { success: "Photo attached." });
  const unlink = useAction(unlinkTaskPhoto, { success: "Photo detached. The file itself is kept." });

  async function upload(file: File): Promise<void> {
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("kind", "photo");
      const response = await fetch("/api/upload", { method: "POST", body });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        toast({
          title: "The photo was not stored",
          description: readUploadMessage(payload) ?? `Upload failed (${response.status}).`,
          tone: "error",
          duration: 0,
        });
        return;
      }
      const attachmentId =
        typeof payload === "object" && payload !== null && typeof (payload as { id?: unknown }).id === "string"
          ? (payload as { id: string }).id
          : null;
      if (attachmentId === null) {
        toast({ title: "The upload returned no file id", tone: "error", duration: 0 });
        return;
      }
      await link.run({ attachmentId, scope, entityId, occurrenceId, role: null });
    } catch {
      // A rejected `fetch` is the phone losing the network mid-upload, or the server going away.
      // Without this the rejection escapes the `void upload(file)` at the call site unhandled: the
      // spinner simply stops and nothing on screen says the photo was not stored. This is the
      // flow that happens standing in a plant room on one bar of signal.
      toast({
        title: "The photo was not sent",
        description:
          "The connection dropped before the upload finished. Nothing was stored — try again.",
        tone: "error",
        duration: 0,
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Panel
      title="Photos"
      subtitle={
        readOnly
          ? "Attached while the work was being done."
          : "Before and after shots, a nameplate, a receipt. Location data is stripped when the file is stored."
      }
      actions={
        readOnly ? null : (
          <Button
            variant="secondary"
            size="sm"
            loading={uploading || link.pending}
            icon={<Camera aria-hidden="true" />}
            onClick={() => inputRef.current?.click()}
          >
            Add a photo
          </Button>
        )
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        capture="environment"
        className="sr-only"
        aria-label="Take or choose a photo"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      {photos.length === 0 ? (
        <p className="text-sm text-ink-3">
          {readOnly
            ? "No photos were attached to this task."
            : "No photos yet. On a phone this opens the camera directly."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((photo) => (
            <li key={photo.linkId} className="group relative">
              <a
                href={`/api/attachments/${photo.attachmentId}`}
                className="block overflow-hidden rounded-md border border-line bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Image
                  src={`/api/attachments/${photo.attachmentId}`}
                  alt={photo.caption ?? photo.originalFilename}
                  width={photo.width ?? 480}
                  height={photo.height ?? 360}
                  unoptimized
                  className="aspect-4/3 h-auto w-full object-cover"
                />
              </a>
              <p className="mt-1 truncate text-xs text-ink-3">
                {photo.caption ?? photo.originalFilename}
              </p>
              {readOnly ? null : (
                <div className="absolute right-1.5 top-1.5">
                  <IconButton
                    label={`Detach ${photo.caption ?? photo.originalFilename}`}
                    size="sm"
                    variant="secondary"
                    loading={unlink.pending}
                    icon={<Trash2 aria-hidden="true" />}
                    onClick={() => void unlink.run({ linkId: photo.linkId, occurrenceId })}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
          <Upload aria-hidden="true" className="size-3.5" />
          JPEG, PNG or WebP. Files are served only to signed-in members, never from a public folder.
        </p>
      )}
    </Panel>
  );
}

function readUploadMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const details = (payload as { details?: unknown }).details;
  if (typeof details === "object" && details !== null) {
    const message = (details as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}
