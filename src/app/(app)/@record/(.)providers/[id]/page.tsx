import Content from "@/app/(app)/providers/[id]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { id } = await props.params;
  await requireSessionPage(`/providers/${id}`);
  return <><RecordSurface href={`/providers/${id}`} hub="/providers" title="Provider" intercepted><Content {...props}/></RecordSurface></>;
}
