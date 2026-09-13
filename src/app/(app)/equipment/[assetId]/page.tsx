import Content from "@/app/(app)/equipment/[assetId]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/equipment/page";
export default async function Page(props: { params: Promise<{ assetId: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { assetId } = await props.params;
  await requireSessionPage(`/equipment/${assetId}`);
  return <><Hub searchParams={Promise.resolve({})}/><RecordSurface href={`/equipment/${assetId}`} hub="/equipment" title="Equipment"><Content {...props}/></RecordSurface></>;
}

export { generateMetadata } from "./RecordContent";
