import { expect, test, type Page } from "@playwright/test";
import { openHouseSession, waitForStableFrames } from "./helpers/house";

test("equipment stacks on equipment and furniture, previews without changing draft, and rotates on drag", async ({ browser }, info) => {
  test.skip(info.project.name === "phone", "Pointer placement is a desktop interaction.");
  const { context, page } = await openHouseSession(browser);
  const ids: string[] = [];
  let furnitureId: string | undefined;
  try {
    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/placements`;
    const available = await (await page.request.get(`${endpoint}?options=placeable`)).json();
    const camera = await page.evaluate(() => window.__vh!.camera());
    const fridgeYaw = Math.atan2(camera.position[0]-2,camera.position[2]-2)*180/Math.PI;
    for (const [name, symbol, position] of [["Eave spot", "fridge", [2,0,2]], ["Porch light", "freezer", [1,0,2]]] as const) {
      const equipment = available.placeable.find((p: { name: string }) => p.name === name);
      expect(equipment).toBeTruthy();
      const response = await page.request.put(endpoint, { data: { fingerprint:status.fingerprint,viewMode:"normal",placement:{ equipmentId:equipment.assetId,
        symbol, position, rotationYDeg:symbol==="fridge"?fridgeYaw:0, floorId:"f-lower",roomId:"r-l-a",mount:{kind:"floor",height:0} } } });
      expect(response.ok()).toBe(true); ids.push((await response.json()).placement.id);
    }
    const furniture = await page.request.put(`/api/house-model/${status.modelId}/furnishings`, { data: {
      fingerprint:status.fingerprint,viewMode:"normal",furnishing:{kind:"cabinet",name:"Support cabinet",floorId:"f-lower",roomId:"r-l-a",position:[1,0,3],rotationYDeg:0,widthM:.9,depthM:.8,heightM:1.2},
    } });
    expect(furniture.ok()).toBe(true); furnitureId=(await furniture.json()).furnishing.id;
    await page.reload(); await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await focusLowerFloor(page);
    await inspectEquipment(page,"Porch light");
    await page.getByRole("button",{name:"Adjust placement (E)",exact:true}).click();
    await waitForStableFrames(page,700);
    // Numeric edits and Save use the same collision policy as the pointer preview.
    await page.getByLabel("X (m)",{exact:true}).fill("2");
    await page.getByLabel("Y (m)",{exact:true}).fill("0");
    await page.getByLabel("Z (m)",{exact:true}).fill("2");
    await page.getByRole("button",{name:"Save placement",exact:true}).click();
    await expect(page.getByRole("alert").filter({hasText:"Overlaps furniture or equipment"})).toBeVisible();
    await expect(page.getByRole("heading",{name:"Adjust placement",exact:true})).toBeVisible();
    await page.getByLabel("X (m)",{exact:true}).fill("1");
    const before = await page.getByLabel("Y (m)",{exact:true}).inputValue();
    const target=await screen(page,[2,1.86,2]);
    await page.mouse.move(target.x,target.y);
    await expect(page.getByLabel("Placement preview",{exact:true})).toBeVisible();
    await expect(page.getByLabel("Y (m)",{exact:true})).toHaveValue(before);
    await page.mouse.click(target.x,target.y);
    await expect.poll(async()=>Number(await page.getByLabel("Y (m)",{exact:true}).inputValue())).toBeCloseTo(1.86,2);
    await page.getByRole("button",{name:"Save placement",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Adjust placement",exact:true})).toBeHidden();
    const saved=(await (await page.request.get(endpoint)).json()).placements.find((p:{id:string})=>p.id===ids[1]);
    expect(saved.position[1]).toBeCloseTo(1.86,2); expect(saved.mount.kind).toBe("free");
    await page.reload(); await page.waitForFunction(()=>window.__vh?.status().phase==="ready");
    await focusLowerFloor(page);
    await inspectEquipment(page,"Porch light");
    await page.getByRole("button",{name:"Adjust placement (E)",exact:true}).click();
    await waitForStableFrames(page,700);
    // A compact control attaches to the fridge's vertical front face. Hover shows the whole
    // candidate without changing numeric fields; clicking commits an outward-facing free mount.
    await page.getByRole("combobox",{name:"Shown as",exact:true}).click();
    await page.getByRole("option",{name:"Remote control",exact:true}).click();
    const canvasRegion=page.getByRole("application",{name:"House 3D view"});
    await canvasRegion.focus();
    await expect(canvasRegion).toBeFocused();
    const cameraBeforeKeys = await page.evaluate(()=>window.__vh!.camera());
    for(let i=0;i<8;i++) await page.keyboard.press("ArrowDown");
    await waitForStableFrames(page,500);
    await expect(canvasRegion).toBeFocused();
    expect((await page.evaluate(()=>window.__vh!.camera())).position).not.toEqual(cameraBeforeKeys.position);
    const beforeFace = await Promise.all(["X","Y","Z"].map(axis=>page.getByLabel(`${axis} (m)`,{exact:true}).inputValue()));
    const fridgeFace=await screen(page,[2,.9,2]);
    await page.mouse.move(fridgeFace.x,fridgeFace.y);
    await expect(page.getByLabel("Placement preview",{exact:true})).toBeVisible();
    expect(await Promise.all(["X","Y","Z"].map(axis=>page.getByLabel(`${axis} (m)`,{exact:true}).inputValue()))).toEqual(beforeFace);
    await page.mouse.click(fridgeFace.x,fridgeFace.y);
    await expect(page.getByRole("radio",{name:"Free / other surface",exact:true})).toBeChecked();
    const attached=await Promise.all(["X","Y","Z"].map(axis=>page.getByLabel(`${axis} (m)`,{exact:true}).inputValue().then(Number)));
    await info.attach("remote-on-fridge-door",{body:await page.screenshot(),contentType:"image/png"});
    expect(attached[1]).toBeGreaterThan(.2); expect(attached[1]).toBeLessThan(1.7);
    const dx=attached[0]!-2,dz=attached[2]!-2,distance=Math.hypot(dx,dz);
    expect(distance).toBeGreaterThan(.29); expect(distance).toBeLessThan(.4);
    const yaw=Number(await page.getByLabel("Rotation around Y (°)",{exact:true}).inputValue())*Math.PI/180;
    expect(Math.abs(Math.atan2(Math.sin(yaw-fridgeYaw*Math.PI/180),Math.cos(yaw-fridgeYaw*Math.PI/180)))).toBeLessThan(.08);
    await page.getByRole("button",{name:"Save placement",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Adjust placement",exact:true})).toBeHidden();
    await page.reload(); await page.waitForFunction(()=>window.__vh?.status().phase==="ready");
    const attachedReloaded=(await (await page.request.get(endpoint)).json()).placements.find((p:{id:string})=>p.id===ids[1]);
    expect(attachedReloaded).toMatchObject({symbol:"remote_control",mount:{kind:"free"},position:attached});
    await focusLowerFloor(page);
    await inspectEquipment(page,"Porch light");
    await page.getByRole("button",{name:"Adjust placement (E)",exact:true}).click();
    await waitForStableFrames(page,700);
    const cabinet=await screen(page,[1,1.2,3]);
    await page.mouse.click(cabinet.x,cabinet.y);
    await expect.poll(async()=>Number(await page.getByLabel("Y (m)",{exact:true}).inputValue())).toBeCloseTo(1.2,2);
    // Drag after pressing a clear floor point: position anchors there while yaw turns.
    const anchor=await screen(page,[1,0,2]); const turn=await screen(page,[1.6,0,2.6]);
    await page.mouse.move(anchor.x,anchor.y);await page.mouse.down();await page.mouse.move(turn.x,turn.y,{steps:8});await page.mouse.up();
    await expect.poll(async()=>Number(await page.getByLabel("Rotation around Y (°)",{exact:true}).inputValue())).toBe(45);
    await expect.poll(async()=>Number(await page.getByLabel("X (m)",{exact:true}).inputValue())).toBeCloseTo(1,1);
    await info.attach("equipment-stacking-and-rotation",{body:await page.screenshot(),contentType:"image/png"});
    await page.getByRole("button",{name:"Cancel (Esc)",exact:true}).click();
  } finally {
    for(const id of ids) await page.request.delete(`/api/house-model/fixture-house/placements/${id}`);
    if(furnitureId) await page.request.delete(`/api/house-model/fixture-house/furnishings?id=${furnitureId}`);
    await context.close();
  }
});

async function screen(page:Page, position:[number,number,number]) {
  return page.evaluate(p=>{const rect=document.querySelector("canvas")!.getBoundingClientRect();const point=window.__vh!.screenOf(p)!;return{x:Math.round(rect.left+point[0]),y:Math.round(rect.top+point[1])};},position);
}

test("other model objects accept precise attachment without changing the draft on hover", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Mouse placement; phone uses numeric coordinates.");
  const { context, page } = await openHouseSession(browser);
  let id: string | undefined;
  try {
    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/placements`;
    const options = await (await page.request.get(`${endpoint}?options=placeable`)).json();
    const equipment = options.placeable.find((item: { name: string }) => item.name === "Eave spot");
    expect(equipment).toBeTruthy();
    const created = await page.request.put(endpoint, { data: {
      fingerprint: status.fingerprint, viewMode: "normal",
      placement: { equipmentId: equipment.assetId, floorId: "f-lower", position: [1, 1, 1], mount: { kind: "free", height: 1 }, symbol: "sensor" },
    } });
    expect(created.ok()).toBe(true);
    id = (await created.json()).placement.id;
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await inspectEquipment(page,"Eave spot");
    await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    const coordinates = () => Promise.all(["X", "Y", "Z"].map((axis) => page.getByLabel(`${axis} (m)`, { exact: true }).inputValue()));
    const before = await coordinates();
    const target = await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const box = canvas.getBoundingClientRect();
      const surfaces = new Set(["s-o-l-door-leaf", "s-o-l-door-reveal", "s-e-l-step", "s-e-roof-fx-north", "s-e-roof-fx-south"]);
      for (let y = 40; y < box.height - 40; y += 12) for (let x = 40; x < box.width - 40; x += 12) {
        if (document.elementFromPoint(box.left + x, box.top + y) !== canvas) continue;
        const hit = window.__vh!.pick(x, y);
        if (hit?.surfaceId && surfaces.has(hit.surfaceId)) return { x: box.left + x, y: box.top + y, surfaceId: hit.surfaceId };
      }
      return null;
    });
    expect(target).not.toBeNull();
    await page.mouse.move(target!.x, target!.y);
    expect(await coordinates()).toEqual(before);
    await page.mouse.click(target!.x, target!.y);
    await expect(page.getByRole("radio", { name: "Free / other surface", exact: true })).toBeChecked();
    await expect(page.getByText(target!.surfaceId, { exact: false }).first()).toBeVisible();
    const attached = await coordinates();
    expect(attached).not.toEqual(before);
    await page.getByLabel("Rotation around Y (°)", { exact: true }).fill("45");
    expect(await coordinates()).toEqual(attached);
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adjust placement", exact: true })).toBeHidden();
    const stored = await (await page.request.get(endpoint)).json();
    expect(stored.placements.find((item: { id: string }) => item.id === id)).toMatchObject({
      symbol: "sensor", mount: { kind: "free", surfaceId: target!.surfaceId }, position: attached.map(Number),
    });
  } finally {
    if (id) await page.request.delete(`/api/house-model/fixture-house/placements/${id}`);
    await context.close();
  }
});

async function focusLowerFloor(page:Page){
  // The floating floor control isolates this floor; framing a browser row only moves the camera.
  await page.getByRole("button",{name:"Lower floor",exact:true}).click();
}
async function inspectEquipment(page:Page,name:string){
  const search=page.getByRole("searchbox",{name:"Search the property"});await search.fill(name);
  await page.getByRole("list",{name:"House items"}).getByRole("button",{name:new RegExp(`^${name}`)}).click();await search.clear();
}

test("furniture pointer selection opens details once and a subsequent model click clears them",async({browser},info)=>{
  test.skip(info.project.name.includes("phone"),"Desktop precise pointer selection");
  const {context,page}=await openHouseSession(browser);let id:string|undefined;
  try{
    const status=await page.evaluate(()=>window.__vh!.status());
    const response=await page.request.put(`/api/house-model/${status.modelId}/furnishings`,{data:{fingerprint:status.fingerprint,viewMode:"normal",furnishing:{kind:"cabinet",name:"Synthetic selectable cabinet",floorId:"f-lower",roomId:null,position:[7,0,5],rotationYDeg:0,widthM:1,depthM:1,heightM:1}}});
    expect(response.ok()).toBe(true);id=(await response.json()).furnishing.id;
    await page.reload();await page.waitForFunction(()=>window.__vh?.status().phase==="ready");await waitForStableFrames(page,500);
    const point=await screen(page,[7,.7,5]);await page.mouse.click(point.x,point.y);
    await expect(page.getByRole("heading",{name:"Synthetic selectable cabinet",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Edit furniture",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Save",exact:true})).toHaveCount(0);
    const background=await page.evaluate(()=>{
      const canvas=document.querySelector("canvas")!,rect=canvas.getBoundingClientRect();
      for(let y=130;y<rect.height-30;y+=30)for(let x=80;x<rect.width-30;x+=30){
        if(document.elementFromPoint(rect.left+x,rect.top+y)===canvas&&!window.__vh!.pick(x,y))return {x:rect.left+x,y:rect.top+y};
      }return null;
    });expect(background).not.toBeNull();await page.mouse.click(background!.x,background!.y);
    await expect(page.getByRole("heading",{name:"Synthetic selectable cabinet",exact:true})).toBeHidden();
  }finally{if(id)await page.request.delete(`/api/house-model/fixture-house/furnishings?id=${id}`);await context.close();}
});
