import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireSessionPage } from "@/server/auth/session";
import HistoryContent from "./HistoryContent";
export default async function HistoryPage(props:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  await requireSessionPage("/history"); const search=await props.searchParams;
  if(typeof search.completion === "string" && search.completion) {
    const rest=new URLSearchParams();for(const [key,value] of Object.entries(search))if(key!=="completion" && typeof value==="string")rest.set(key,value);
    redirect(`/history/completions/${encodeURIComponent(search.completion)}${rest.size?`?${rest}`:""}` as Route);
  }
  return <HistoryContent {...props}/>;
}
