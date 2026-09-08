"use client";
/**
 * Close-up photos on the equipment page's "Where to find it" panel: a shot of the shutoff valve,
 * the breaker, the filter's exact orientation — whatever a future visit would otherwise have to
 * rediscover.
 *
 * Thumbnails use the `thumb` derivative so the panel stays light even with a dozen photos; the
 * dialog opens the `web` derivative, which is still far smaller than the original JPEG a phone
 * camera produces. Both are served only through the authenticated `/api/attachments/[id]` route.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Trash2 } from "lucide-react";
import { Button, Dialog, IconButton } from "@/ui";
import { useAction } from "@/features/settings/actionClient";
import { linkAssetAttachment, unlinkAssetAttachment } from "@/server/actions/assets/attachments";
import { AssetUploader } from "./AssetUploader";

export interface CloseUpPhoto {
  id: string;
  caption: string | null;
  originalFilename: string;
  width: number | null;
  height: number | null;
}

export function AssetCloseUpPhotos({
  assetId,
  photos,
}: {
  assetId: string;
  photos: readonly CloseUpPhoto[];
}) {
  const router = useRouter();
  const [viewing, setViewing] = useState<CloseUpPhoto | null>(null);
  const [removing, setRemoving] = useState<CloseUpPhoto | null>(null);

  const link = useAction(linkAssetAttachment, {
    successTitle: "Photo attached",
    onSuccess: () => router.refresh(),
  });
  const unlink = useAction(unlinkAssetAttachment, {
    successTitle: "Photo removed. The file itself is kept.",
    onSuccess: () => {
      setRemoving(null);
      router.refresh();
    },
  });

  return (
    <div className="flex flex-col gap-3">
      {photos.length === 0 ? (
        <p className="text-sm leading-6 text-ink-2">
          No close-up photos yet. A shot of the shutoff valve, the breaker, or exactly how a panel
          comes off saves the most time on the next visit.
        </p>
      ) : (
        <ul className="flex list-none flex-wrap gap-3">
          {photos.map((photo) => (
            <li key={photo.id} className="relative">
              <button
                type="button"
                onClick={() => setViewing(photo)}
                className="block size-24 overflow-hidden rounded-md border border-line bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:size-28"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/attachments/${photo.id}?v=thumb`}
                  alt={photo.caption ?? photo.originalFilename}
                  width={photo.width ?? 160}
                  height={photo.height ?? 120}
                  className="size-full object-cover"
                />
              </button>
              <div className="absolute right-1 top-1">
                <IconButton
                  label={`Remove ${photo.caption ?? photo.originalFilename}`}
                  size="sm"
                  variant="secondary"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => setRemoving(photo)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div>
        <AssetUploader
          accept="image/jpeg,image/png,image/webp"
          capture
          kind="photo"
          label="Add a close-up photo"
          icon={<Camera aria-hidden="true" />}
          inputLabel="Take or choose a close-up photo"
          disabled={link.pending}
          onUploaded={(file) =>
            link.run({ assetId, attachmentId: file.id, role: "close_up" })
          }
        />
      </div>

      {viewing === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setViewing(null);
          }}
          size="lg"
          title={viewing.caption ?? viewing.originalFilename}
          description="The full-size copy. Location data was stripped when it was stored."
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/attachments/${viewing.id}?v=web`}
            alt={viewing.caption ?? viewing.originalFilename}
            className="max-h-[70dvh] w-full rounded-md border border-line object-contain"
          />
        </Dialog>
      )}

      {removing === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          size="sm"
          title="Remove this photo?"
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
