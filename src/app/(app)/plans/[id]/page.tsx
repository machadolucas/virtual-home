import Content from "@/app/(app)/plans/[id]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/plans/page";
export default async function Page(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { id } = await props.params;
  await requireSessionPage(`/plans/${id}`);
  return <><Hub/><RecordSurface href={`/plans/${id}`} hub="/plans" title="Maintenance plan"><Content {...props}/></RecordSurface></>;
}
