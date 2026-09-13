import Content from "@/app/(app)/providers/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/providers/page";
export default async function Page(){await requireSessionPage("/providers/new");return <><Hub searchParams={Promise.resolve({})}/><RecordSurface href="/providers/new" hub="/providers" title="New provider"><Content/></RecordSurface></>;}
