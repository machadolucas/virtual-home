import Content from "@/app/(app)/documents/[id]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/documents/page";
export default async function Page(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { id } = await props.params;
  await requireSessionPage(`/documents/${id}`);
  return <><Hub searchParams={Promise.resolve({})}/><RecordSurface href={`/documents/${id}`} hub="/documents" title="Document"><Content {...props}/></RecordSurface></>;
}
