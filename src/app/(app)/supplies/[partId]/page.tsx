import Content from "@/app/(app)/supplies/[partId]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/supplies/page";
export default async function Page(props: { params: Promise<{ partId: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { partId } = await props.params;
  await requireSessionPage(`/supplies/${partId}`);
  return <><Hub searchParams={Promise.resolve({})}/><RecordSurface href={`/supplies/${partId}`} hub="/supplies" title="Supply"><Content {...props}/></RecordSurface></>;
}

export { generateMetadata } from "./RecordContent";
