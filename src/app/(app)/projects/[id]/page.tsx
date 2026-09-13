import Content from "@/app/(app)/projects/[id]/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/projects/page";
export default async function Page(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { id } = await props.params;
  await requireSessionPage(`/projects/${id}`);
  return <><Hub/><RecordSurface href={`/projects/${id}`} hub="/projects" title="Project"><Content {...props}/></RecordSurface></>;
}

export { generateMetadata } from "./RecordContent";
