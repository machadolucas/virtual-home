import Content from "@/app/(app)/supplies/[partId]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(props: { params: Promise<{ partId: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { partId } = await props.params;
  await requireSessionPage(`/supplies/${partId}`);
  return <><RecordSurface href={`/supplies/${partId}`} hub="/supplies" title="Supply" intercepted><Content {...props}/></RecordSurface></>;
}
