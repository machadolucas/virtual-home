import Content from "@/app/(app)/documents/[id]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { id } = await props.params;
  await requireSessionPage(`/documents/${id}`);
  return <><RecordSurface href={`/documents/${id}`} hub="/documents" title="Document" intercepted><Content {...props}/></RecordSurface></>;
}
