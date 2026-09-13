import Content from "@/app/(app)/equipment/[assetId]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(props: { params: Promise<{ assetId: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { assetId } = await props.params;
  await requireSessionPage(`/equipment/${assetId}`);
  return <><RecordSurface href={`/equipment/${assetId}`} hub="/equipment" title="Equipment" intercepted><Content {...props}/></RecordSurface></>;
}
