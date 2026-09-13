import Content from "@/app/(app)/plans/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(){await requireSessionPage("/plans/new");return <><RecordSurface href="/plans/new" hub="/plans" title="New maintenance plan" intercepted><Content/></RecordSurface></>;}
