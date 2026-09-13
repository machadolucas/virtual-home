export type RecordNavigation = { session: string; href: string; origin: string; depth: number; direct: boolean };
export function matchingNavigation(value: unknown, session: string, href: string): RecordNavigation | null {
  if(!value || typeof value!=="object")return null;
  const item=value as Partial<RecordNavigation>;
  return item.session===session && item.href===href && typeof item.origin==="string" && item.origin.startsWith("/") && !item.origin.startsWith("//") && typeof item.depth==="number" && Number.isSafeInteger(item.depth) && item.depth>=0 && typeof item.direct==="boolean" ? item as RecordNavigation : null;
}
/** Metadata belongs to real history entries; opening a record never adds a synthetic Back stop. */
export function deriveNavigation(input:{session:string;href:string;hub:string;intercepted:boolean;from:string;previous:RecordNavigation|null;marker:unknown}):RecordNavigation {
  const restored=matchingNavigation(input.marker,input.session,input.href);
  if(restored)return restored;
  if(!input.intercepted)return {session:input.session,href:input.href,origin:input.hub,depth:0,direct:true};
  const fromPath=input.from.split("?")[0]?.split("#")[0];
  if(input.previous && input.previous.href===fromPath)return {...input.previous,href:input.href,depth:input.previous.depth+1};
  return {session:input.session,href:input.href,origin:input.from,depth:1,direct:false};
}
/** Reserved hub names must never be treated as record IDs. */
export function isRecordPath(pathname:string):boolean {
  if(pathname==="/equipment/systems" || pathname==="/supplies/shopping")return false;
  return /^\/(equipment|supplies|projects|plans|procedures|providers|documents|tasks)\/[^/]+\/?$/.test(pathname) || /^\/history\/completions\/[^/]+\/?$/.test(pathname);
}
