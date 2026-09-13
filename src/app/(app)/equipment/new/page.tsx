import Content from "@/app/(app)/equipment/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/equipment/page";
export default async function Page(){await requireSessionPage("/equipment/new");return <><Hub searchParams={Promise.resolve({})}/><RecordSurface href="/equipment/new" hub="/equipment" title="New equipment"><Content/></RecordSurface></>;}
