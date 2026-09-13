import { expect,it } from "vitest";
import { deriveNavigation,isRecordPath } from "@/features/records/navigation";
it("closes a contextual chain to its exact originating URL and restores entries on Back",()=>{
 const a=deriveNavigation({session:"one",href:"/equipment/a",hub:"/equipment",intercepted:true,from:"/house?floor=lower&sel=lamp",previous:null,marker:null});
 const b=deriveNavigation({session:"one",href:"/providers/b",hub:"/providers",intercepted:true,from:"/equipment/a",previous:a,marker:null});
 expect(b).toMatchObject({origin:"/house?floor=lower&sel=lamp",depth:2,direct:false});
 expect(deriveNavigation({session:"one",href:a.href,hub:"/equipment",intercepted:true,from:b.href,previous:b,marker:a})).toEqual(a);
});
it("direct and reloaded record chains close to the canonical hub without trusting an old session",()=>{
 const a=deriveNavigation({session:"one",href:"/equipment/a",hub:"/equipment",intercepted:false,from:"/equipment/a",previous:null,marker:null});
 expect(deriveNavigation({session:"one",href:"/providers/b",hub:"/providers",intercepted:true,from:a.href,previous:a,marker:null})).toMatchObject({origin:"/equipment",direct:true,depth:1});
 expect(deriveNavigation({session:"two",href:"/providers/b",hub:"/providers",intercepted:false,from:"/providers/b",previous:null,marker:a})).toMatchObject({origin:"/providers",direct:true,depth:0});
});
it("distinguishes retained record navigation from real hub departures",()=>{
 expect(isRecordPath("/equipment/new")).toBe(true);expect(isRecordPath("/history/completions/abc")).toBe(true);
 for(const path of ["/equipment","/equipment/systems","/supplies/shopping","/today","/settings/security"])expect(isRecordPath(path)).toBe(false);
});
