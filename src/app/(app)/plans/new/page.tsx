import Content from "@/app/(app)/plans/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/plans/page";
export default async function Page(){await requireSessionPage("/plans/new");return <><Hub/><RecordSurface href="/plans/new" hub="/plans" title="New maintenance plan"><Content/></RecordSurface></>;}
