"use client";
/**
 * A file picker that stages a file at `/api/upload` and hands the resulting attachment back to
 * the caller.
 *
 * This is the part of `src/features/maintenance/PhotoUploader.tsx` that has nothing to do with
 * maintenance: posting the file, showing upload progress, and turning an upload failure into a
 * readable toast. What happens with the returned attachment id (which role, which entity, whether
 * a second server action runs) is the caller's business, so this component takes an `onUploaded`
 * callback instead of calling a server action itself — the equipment page needs two different
 * links (a close-up photo, a manual with a chosen role) from the same upload mechanics.
 */
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/ui";
import { toast } from "@/ui";

export interface UploadedFile {
  id: string;
  originalFilename: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}

export interface AssetUploaderProps {
  /** e.g. `"image/jpeg,image/png,image/webp"` or `"application/pdf,image/*"`. */
  accept: string;
  /** Opens the rear camera directly on a phone. Only sensible when `accept` is image-only. */
  capture?: boolean;
  /** Forwarded to `/api/upload`'s `kind` field. Omit to let the server sniff it. */
  kind?: "photo" | "pdf" | "manual" | "video" | "other";
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Accessible name for the hidden input, read by screen readers before the button's own label. */
  inputLabel: string;
  onUploaded: (file: UploadedFile) => Promise<void> | void;
}

/** `POST /api/upload`, then `onUploaded` — see `src/app/api/upload/route.ts` for the response shape. */
export function AssetUploader({
  accept,
  capture = false,
  kind,
  label,
  icon,
  disabled = false,
  inputLabel,
  onUploaded,
}: AssetUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File): Promise<void> {
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      if (kind !== undefined) body.set("kind", kind);
      const response = await fetch("/api/upload", { method: "POST", body });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        toast({
          title: "The file was not stored",
          description: readUploadMessage(payload) ?? `Upload failed (${response.status}).`,
          tone: "error",
          duration: 0,
        });
        return;
      }
      const parsed = readUploadedFile(payload);
      if (parsed === null) {
        toast({ title: "The upload returned no file id", tone: "error", duration: 0 });
        return;
      }
      await onUploaded(parsed);
    } catch {
      // A rejected `fetch` is a dropped connection or a server that went away mid-upload. Without
      // this the rejection escapes the `void upload(file)` at the call site unhandled, the spinner
      // just stops, and nothing on screen says the file never arrived.
      toast({
        title: "The file was not sent",
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
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture={capture ? "environment" : undefined}
        className="sr-only"
        aria-label={inputLabel}
        disabled={disabled || uploading}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={uploading}
        disabled={disabled}
        icon={icon}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </Button>
    </>
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

function readUploadedFile(payload: unknown): UploadedFile | null {
  if (typeof payload !== "object" || payload === null) return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.id !== "string") return null;
  return {
    id: row.id,
    originalFilename: typeof row.originalFilename === "string" ? row.originalFilename : "file",
    byteSize: typeof row.byteSize === "number" ? row.byteSize : 0,
    width: typeof row.width === "number" ? row.width : null,
    height: typeof row.height === "number" ? row.height : null,
  };
}
