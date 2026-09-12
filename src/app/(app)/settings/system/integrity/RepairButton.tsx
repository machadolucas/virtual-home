"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/ui";
import { quarantineOrphan, restoreQuarantined } from "@/server/actions/settings/integrity";
export function RepairButton({ file, restoreId, cleanup = false }: { file?: string; restoreId?: string; cleanup?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div><Button size="sm" variant="secondary" loading={pending} onClick={async () => { setPending(true); setError(null); try { const result = restoreId ? await restoreQuarantined(restoreId) : await quarantineOrphan(file); if (!result.ok) setError(result.error); } catch (err) { setError(err instanceof Error ? err.message : "Could not move the file."); } finally { setPending(false); router.refresh(); } }}>{cleanup ? "Clean up copy" : restoreId ? "Restore file" : "Move to quarantine"}</Button>{error ? <p role="alert" className="text-sm text-overdue">{error}</p> : null}</div>;
}
