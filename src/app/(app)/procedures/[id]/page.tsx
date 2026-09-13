import Content from "@/app/(app)/procedures/[id]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/procedures/page";
export default async function Page(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { id } = await props.params;
  await requireSessionPage(`/procedures/${id}`);
  return <><Hub/><RecordSurface href={`/procedures/${id}`} hub="/procedures" title="Procedure"><Content {...props}/></RecordSurface></>;
}
