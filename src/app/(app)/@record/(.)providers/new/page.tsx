import Content from "@/app/(app)/providers/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(){await requireSessionPage("/providers/new");return <><RecordSurface href="/providers/new" hub="/providers" title="New provider" intercepted><Content/></RecordSurface></>;}
