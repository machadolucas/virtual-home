import { expect,test } from "@playwright/test";
import { openHouseSession } from "./helpers/house";

test("unfinished equipment and tree details survive browsing until explicitly cancelled",async({browser},info)=>{
  test.skip(info.project.name.includes("phone"),"Desktop creation draft coverage");
  const {context,page}=await openHouseSession(browser);
  const add=async(kind:string)=>{await page.getByRole("button",{name:"Add",exact:true}).click();await page.getByLabel("Add to house",{exact:true}).getByRole("button",{name:kind,exact:true}).click();};
  try{
    await add("Equipment");await page.getByLabel("Equipment name",{exact:true}).fill("Synthetic unfinished pump");await page.getByLabel(/^Notes/).fill("Keep installation details");
    await add("Tree");await page.getByLabel("Tree name",{exact:true}).fill("Synthetic unfinished tree");await page.getByLabel("Height (metres)",{exact:true}).fill("2.5");
    await add("Equipment");await expect(page.getByLabel("Equipment name",{exact:true})).toHaveValue("Synthetic unfinished pump");await expect(page.getByLabel(/^Notes/)).toHaveValue("Keep installation details");
    await page.getByRole("button",{name:"Cancel draft",exact:true}).click();
    await add("Equipment");await expect(page.getByLabel("Equipment name",{exact:true})).toHaveValue("");
    await add("Tree");await expect(page.getByLabel("Tree name",{exact:true})).toHaveValue("Synthetic unfinished tree");await expect(page.getByLabel("Height (metres)",{exact:true})).toHaveValue("2.5");
  }finally{await context.close();}
});

test("Add tree saves documented equipment and physical placement together",async({browser},info)=>{
  test.skip(info.project.name.includes("phone"),"Desktop creation regression; phone layout is covered by browser journeys.");
  const {context,page}=await openHouseSession(browser);let placementId:string|undefined;
  try{
    const status=await page.evaluate(()=>window.__vh!.status());const endpoint=`/api/house-model/${status.modelId}/placements`;
    const name=`Synthetic saved tree ${info.project.name}`;
    const absent=async()=>{const body=await(await page.request.get(`${endpoint}?options=placeable`)).json();expect(body.placeable.some((row:{name:string})=>row.name===name)).toBe(false);};
    await page.getByRole("button",{name:"Add",exact:true}).click();await page.getByRole("button",{name:"Tree",exact:true}).click();
    await page.getByLabel("Tree name",{exact:true}).fill(name);await page.getByLabel("Height (metres)",{exact:true}).fill("3.5");
    await page.getByLabel(/^Notes/).fill("Synthetic planting and care instructions");
    await page.getByRole("button",{name:"Place tree",exact:true}).click();await absent();
    await page.getByLabel("X (m)",{exact:true}).fill("999");await page.getByRole("button",{name:"Save placement",exact:true}).click();
    await expect(page.getByRole("alert").filter({hasText:"outside the model"})).toBeVisible();await absent();
    await page.getByLabel("X (m)",{exact:true}).fill("-2");await page.getByLabel("Y (m)",{exact:true}).fill("0");await page.getByLabel("Z (m)",{exact:true}).fill("-2");
    await page.getByRole("button",{name:"Save placement",exact:true}).click();await expect(page.getByRole("button",{name:"Save placement",exact:true})).toBeHidden();
    const body=await(await page.request.get(endpoint)).json();const tree=body.placements.find((row:{name:string})=>row.name===name);
    expect(tree).toMatchObject({symbol:"tree",treeHeightM:3.5,position:[-2,0,-2],category:"outdoor"});placementId=tree.id;
    const equipment=await page.request.get(`/equipment/${tree.equipmentId}`);expect(equipment.ok()).toBe(true);expect(await equipment.text()).toContain("Synthetic planting and care instructions");
    await page.reload();await page.waitForFunction(()=>window.__vh?.status().phase==="ready");
    await page.getByRole("button",{name:"Trees",exact:true}).click();await expect(page.getByRole("list",{name:"House items"})).toContainText(name);
  }finally{if(placementId)await page.request.delete(`/api/house-model/fixture-house/placements/${placementId}`);await context.close();}
});

test("switching creation offers Keep editing, Discard, or actual Save",async({browser},info)=>{
  test.skip(info.project.name.includes("phone"),"Desktop transition coverage");
  const {context,page}=await openHouseSession(browser);const savedIds:string[]=[];
  try{
    const status=await page.evaluate(()=>window.__vh!.status());const endpoint=`/api/house-model/${status.modelId}/placements`;
    for(const choice of ["Keep editing","Discard","Save and continue"]){
      const name=`Synthetic transition ${choice}`;
      await page.getByRole("button",{name:"Add",exact:true}).click();await page.getByRole("button",{name:"Tree",exact:true}).click();
      await page.getByLabel("Tree name",{exact:true}).fill(name);await page.getByLabel("Height (metres)",{exact:true}).fill("1");await page.getByRole("button",{name:"Place tree",exact:true}).click();
      await page.getByLabel("X (m)",{exact:true}).fill("-3");await page.getByLabel("Y (m)",{exact:true}).fill("0");await page.getByLabel("Z (m)",{exact:true}).fill("-2");
      await page.getByRole("button",{name:"Add",exact:true}).click();await page.getByRole("button",{name:"Equipment",exact:true}).click();
      const prompt=page.getByRole("dialog",{name:"Save your current edit?"});await expect(prompt).toBeVisible();
      for(const label of ["Keep editing","Discard","Save and continue"])await expect(prompt.getByRole("button",{name:label,exact:true})).toBeVisible();
      await prompt.getByRole("button",{name:choice,exact:true}).click();await expect(prompt).toBeHidden();
      if(choice==="Keep editing"){
        await expect(page.getByRole("button",{name:"Save placement",exact:true})).toBeVisible();await expect(page.getByLabel("X (m)",{exact:true})).toHaveValue("-3");
        await page.getByRole("button",{name:"Cancel (Esc)",exact:true}).click();
      }else await expect(page.getByLabel("Equipment name",{exact:true})).toBeVisible();
      const body=await(await page.request.get(endpoint)).json();const created=body.placements.find((row:{name:string})=>row.name===name);
      if(choice==="Save and continue"){expect(created).toMatchObject({symbol:"tree",position:[-3,0,-2]});savedIds.push(created.id);}else expect(created).toBeUndefined();
    }
  }finally{for(const id of savedIds)await page.request.delete(`/api/house-model/fixture-house/placements/${id}`);await context.close();}
});
