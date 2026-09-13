import { expect, test } from "@playwright/test";
import { login, nextClientIp } from "./fixtures";

test("canonical record URLs render a closable modal over their hub, including unavailable records",async({page})=>{
  await page.context().setExtraHTTPHeaders({"x-forwarded-for":nextClientIp()});
  await login(page,"lucas",{next:"/equipment"});
  for(const [path,title,hub] of [
    ["/equipment/not-a-record","Equipment","/equipment"],
    ["/supplies/not-a-record","Supply","/supplies"],
    ["/projects/not-a-record","Project","/projects"],
    ["/plans/not-a-record","Maintenance plan","/plans"],
    ["/procedures/not-a-record","Procedure","/procedures"],
    ["/providers/not-a-record","Provider","/providers"],
    ["/documents/not-a-record","Document","/documents"],
    ["/tasks/not-a-record","Task","/today"],
  ]) {
    await page.goto(path!);
    const dialog=page.getByRole("dialog",{name:title!,exact:true});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/This record is unavailable/)).toBeVisible();
    await dialog.getByRole("button",{name:"Close",exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`${hub}$`));
    await expect(page.getByRole("dialog")).toBeHidden();
  }
});

test("legacy completion URLs retain access through the canonical modal route",async({page})=>{
  await page.context().setExtraHTTPHeaders({"x-forwarded-for":nextClientIp()});
  await login(page,"lucas",{next:"/history"});
  await page.goto("/history?completion=missing-completion&from=2026-01-01");
  await expect(page).toHaveURL(/\/history\/completions\/missing-completion\?from=2026-01-01$/);
  const dialog=page.getByRole("dialog",{name:"Recorded completion",exact:true});
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button",{name:"Close",exact:true}).click();
  await expect(page).toHaveURL(/\/history$/);
});

test("opening a house equipment record preserves its canvas, selection and camera",async({browser},info)=>{
  const {openHouseSession,vh,waitForStableFrames}=await import("./helpers/house");
  const {context,page}=await openHouseSession(browser);
  let placementId:string|undefined;
  try {
    const status=await vh(page).status();
    const endpoint=`/api/house-model/${status.modelId}/placements`;
    const options=await(await page.request.get(`${endpoint}?options=placeable`)).json();
    const equipment=options.placeable.find((item:{name:string})=>item.name==="Viewer test lamp");
    expect(equipment).toBeTruthy();
    const created=await page.request.put(endpoint,{data:{fingerprint:status.fingerprint,viewMode:"normal",placement:{equipmentId:equipment.assetId,floorId:"f-lower",position:[1,1,1],mount:{kind:"free",height:1},symbol:"sensor"}}});
    expect(created.ok()).toBe(true);placementId=(await created.json()).placement.id;
    await page.reload();await page.waitForFunction(()=>window.__vh?.status().phase==="ready");
    await page.getByRole("button",{name:"Fullscreen",exact:true}).click();
    await vh(page).select({kind:"equipment",id:placementId!});
    await waitForStableFrames(page,400);
    const canvas=await page.locator("canvas").elementHandle();
    const camera=await vh(page).camera();const selection=await page.evaluate(()=>window.__vh!.selection());const origin=page.url();
    await page.getByRole("link",{name:"Open full record",exact:true}).click();
    const record=page.getByRole("dialog",{name:"Equipment",exact:true});
    await expect(record).toBeVisible();
    await record.getByRole("button",{name:"Close",exact:true}).click();
    await expect(record).toBeHidden();await expect(page).toHaveURL(origin);
    expect(await canvas!.evaluate(node=>node.isConnected && node===document.querySelector("canvas"))).toBe(true);
    expect(await page.evaluate(()=>window.__vh!.selection())).toEqual(selection);
    expect((await vh(page).camera()).position).toEqual(camera.position);
    if(info.project.name.includes("phone"))await page.getByRole("dialog",{name:"Selected item",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
    await expect(page.getByRole("button",{name:"Exit fullscreen",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Exit fullscreen",exact:true}).click();
  }finally{
    if(placementId)await page.request.delete(`/api/house-model/fixture-house/placements/${placementId}`);
    await context.close();
  }
});

test("static shopping and systems hubs are not mistaken for dynamic records",async({page})=>{
 await page.context().setExtraHTTPHeaders({"x-forwarded-for":nextClientIp()});
 await login(page,"lucas",{next:"/equipment"});
 await page.locator('a[href="/equipment/systems"]:visible').click();
 await expect(page).toHaveURL(/\/equipment\/systems$/);
 await expect(page.getByRole("heading",{name:"Systems",exact:true})).toBeVisible();
 await expect(page.getByRole("dialog")).toBeHidden();
 await page.locator('a[href="/supplies/shopping"]:visible').first().click();
 await expect(page).toHaveURL(/\/supplies\/shopping$/);
 await expect(page.getByRole("heading",{name:"Shopping list",exact:true})).toBeVisible();
 await expect(page.getByRole("dialog")).toBeHidden();
});

test("Close exits a related-record chain while Back and Forward traverse records",async({page},info)=>{
 await page.context().setExtraHTTPHeaders({"x-forwarded-for":nextClientIp()});
 await login(page,"lucas",{next:"/plans/new"});
 const title=`Record chain ${info.project.name} ${Date.now()}`;
 await page.getByLabel(/^What needs doing/).fill(title);
 await page.getByRole("combobox",{name:/^What it is attached to/}).click();
 await page.getByRole("option",{name:/Yard lamp/}).click();
 await page.getByRole("radio",{name:/^Once only/}).check();
 await page.getByLabel(/^Due date/).fill("2026-09-13");
 await page.getByRole("button",{name:"Create the plan",exact:true}).click();
 await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/);
 const planUrl=page.url();const planPath=new URL(planUrl).pathname;
 await page.goto("/plans?context=record-chain");const origin=page.url();
 await page.locator(`a[href="${planPath}"]:visible`).first().click();
 await expect(page.getByRole("dialog",{name:"Maintenance plan",exact:true})).toBeVisible();
 await page.getByRole("dialog",{name:"Maintenance plan",exact:true}).locator('a[href^="/tasks/"]:visible').first().click();
 await expect(page.getByRole("dialog",{name:"Task",exact:true})).toBeVisible();const taskUrl=page.url();
 await page.goBack();await expect(page).toHaveURL(planUrl);
 await expect(page.getByRole("dialog",{name:"Maintenance plan",exact:true})).toBeVisible();
 await page.goForward();await expect(page).toHaveURL(taskUrl);
 await page.getByRole("dialog",{name:"Task",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
 await expect(page).toHaveURL(origin);await expect(page.getByRole("dialog")).toBeHidden();
 await expect(page.locator(`a[href="${planPath}"]:visible`).first()).toBeFocused();
});
