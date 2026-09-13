import Content from "@/app/(app)/supplies/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(){await requireSessionPage("/supplies/new");return <><RecordSurface href="/supplies/new" hub="/supplies" title="New supply" intercepted><Content/></RecordSurface></>;}
