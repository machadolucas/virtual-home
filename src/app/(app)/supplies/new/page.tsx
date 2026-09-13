import Content from "@/app/(app)/supplies/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/supplies/page";
export default async function Page(){await requireSessionPage("/supplies/new");return <><Hub searchParams={Promise.resolve({})}/><RecordSurface href="/supplies/new" hub="/supplies" title="New supply"><Content/></RecordSurface></>;}
