import Content from "@/app/(app)/projects/new/RecordContent";
import { RecordSurface } from "@/features/records/RecordSurface";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(){await requireSessionPage("/projects/new");return <><RecordSurface href="/projects/new" hub="/projects" title="New project" intercepted><Content/></RecordSurface></>;}
