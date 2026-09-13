import Content from "@/app/(app)/providers/[id]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/providers/page";
export default async function Page(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { id } = await props.params;
  await requireSessionPage(`/providers/${id}`);
  return <><Hub searchParams={Promise.resolve({})}/><RecordSurface href={`/providers/${id}`} hub="/providers" title="Provider"><Content {...props}/></RecordSurface></>;
}
