import Content from "@/app/(app)/tasks/[id]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { id } = await props.params;
  await requireSessionPage(`/tasks/${id}`);
  return <><RecordSurface href={`/tasks/${id}`} hub="/today" title="Task" intercepted><Content {...props}/></RecordSurface></>;
}
