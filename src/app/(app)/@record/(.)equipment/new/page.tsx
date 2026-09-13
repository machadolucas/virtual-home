import Content from "@/app/(app)/equipment/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(){await requireSessionPage("/equipment/new");return <><RecordSurface href="/equipment/new" hub="/equipment" title="New equipment" intercepted><Content/></RecordSurface></>;}
