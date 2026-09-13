import Hub from "@/app/(app)/supplies/shopping/page";
import { requireSessionPage } from "@/server/auth/session";
export default async function Page(){await requireSessionPage("/supplies/shopping");return <Hub/>;}
