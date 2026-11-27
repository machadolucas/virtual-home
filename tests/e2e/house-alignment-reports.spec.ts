import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import manifest from "../fixtures/model/house-model/model.json";
import { login, nextClientIp } from "./fixtures";

test("a failed Quest alignment opens as a private, reviewable plan",async ({page})=>{
  const base="/api/house-model/"+manifest.modelId;
  await page.context().setExtraHTTPHeaders({"x-forwarded-for":nextClientIp()});
  expect((await page.request.get(base+"/alignment-attempts")).status()).toBe(401);
  await login(page,"marja",{next:"/house"});
  const room=manifest.rooms[0]!;
  const id=randomUUID();
  const status=await page.evaluate(async({base,id,roomId})=>{
    const {user}=await (await fetch("/api/auth/get-session")).json();
    const {fingerprint}=await (await fetch(base+"/status")).json();
    const result=await fetch(base+"/alignment-attempts",{method:"POST",headers:{"Content-Type":"application/json","X-VH-Alignment":"1"},
      body:JSON.stringify({id,userId:user.id,fingerprint,startedAtMs:Date.now()-1500,elapsedMs:1500,revision:1,
        mode:"mr",status:"ended",roomId,features:["plane-detection"],events:[{atMs:1000,kind:"paired-wall",detail:"Fixture wall pairing could not be verified."}],
        snapshots:[{atMs:900,space:0,roomId,viewer:[1,1.6,1],floor:{y:0,source:"plane",outline:[[0,0],[3,0],[3,2],[0,2]]},
          walls:[],landmarks:[{kind:"door",center:[1,1,0],height:2,width:.9}],traces:[],diagnosis:null}]})});
    return result.status;
  },{base,id,roomId:room.id});
  expect(status).toBe(200);
  await page.getByRole("button",{name:"View",exact:true}).click();
  await page.getByRole("button",{name:"Alignment reports",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Alignment reports"});
  await dialog.getByRole("button",{name:/Ended before alignment/}).first().click();
  await expect(dialog.getByRole("img",{name:/Recorded headset geometry/})).toBeVisible();
  await expect(dialog.getByRole("img",{name:"Model room footprint"})).toBeVisible();
  await expect(dialog.getByText(/Green doors \(1\)/)).toBeVisible();
  await dialog.getByText("Attempt timeline").click();
  await expect(dialog.getByText(/Fixture wall pairing could not be verified/)).toBeVisible();
});
