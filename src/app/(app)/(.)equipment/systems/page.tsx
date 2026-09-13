import Hub from "@/app/(app)/equipment/systems/page";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(){await requireSessionPage("/equipment/systems");return <Hub/>;}
