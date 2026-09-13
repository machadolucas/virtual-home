import Content from "@/app/(app)/projects/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
import Hub from "@/app/(app)/projects/page";
export default async function Page(){await requireSessionPage("/projects/new");return <><Hub/><RecordSurface href="/projects/new" hub="/projects" title="New project"><Content/></RecordSurface></>;}
