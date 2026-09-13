import { requireSessionPage } from "@/server/auth/session";
import HistoryContent from "@/app/(app)/history/HistoryContent";
import { RecordSurface } from "@/features/records/RecordSurface";
export default async function CompletionPage(props:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const {id}=await props.params;await requireSessionPage(`/history/completions/${id}`);
 return <><HistoryContent searchParams={props.searchParams}/><RecordSurface href={`/history/completions/${id}`} hub="/history" title="Recorded completion"><HistoryContent searchParams={Promise.resolve({completion:id})}/></RecordSurface></>;
}
