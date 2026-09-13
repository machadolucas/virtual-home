import Content from "@/app/(app)/tasks/[id]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/today/page";
export default async function Page(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { id } = await props.params;
  await requireSessionPage(`/tasks/${id}`);
  return <><Hub/><RecordSurface href={`/tasks/${id}`} hub="/today" title="Task"><Content {...props}/></RecordSurface></>;
}
