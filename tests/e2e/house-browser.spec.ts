import { expect, test } from "@playwright/test";
import { openHouseSession, vh } from "./helpers/house";

test("scoped browsing keeps navigation separate from selection and exposes creation",async({browser},info)=>{
 const {context,page}=await openHouseSession(browser);
 try{
  if(info.project.name.includes("phone"))await page.getByRole("button",{name:"Browse / Add",exact:true}).click();
  await expect(page.getByRole("button",{name:"Add",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Browse Fixture house",exact:true})).toBeVisible();
  const pose=await vh(page).camera();
  await page.getByRole("button",{name:"Browse Fixture house",exact:true}).click();
  expect((await vh(page).camera()).position).toEqual(pose.position);
  await page.getByRole("button",{name:"Browse Lower floor",exact:true}).click();
  await expect(page.getByRole("navigation",{name:"House location"})).toContainText("Lower floor");
  await page.getByRole("button",{name:"Add",exact:true}).click();
  for(const name of ["Equipment","Furniture","Tree","Pipe, duct or cable","Inlet or endpoint","Note or measurement"]) await expect(page.getByRole("button",{name,exact:true}).last()).toBeVisible();
  await page.getByRole("button",{name:"Tree",exact:true}).click();
  await page.getByLabel("Tree name",{exact:true}).fill(`Draft tree ${info.project.name}`);
  await page.getByRole("button",{name:"Place tree",exact:true}).click();
  await expect(page.getByRole("button",{name:"Save placement",exact:true})).toBeVisible();
  expect(await vh(page).placementDraft()).not.toBeNull();
  await expect(page.getByLabel("Tree height (m)",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Cancel (Esc)",exact:true}).click();
  expect(await vh(page).placementDraft()).toBeNull();
  await page.screenshot({path:test.info().outputPath("house-browser.png")});
 }finally{await context.close();}
});

test("normal browsing clears selection and View has no nested tabs",async({browser},info)=>{
 test.skip(info.project.name.includes("phone"),"Desktop canvas pointer assertion");
 const {context,page}=await openHouseSession(browser);
 try{
  await page.getByRole("button",{name:"Browse Fixture house",exact:true}).click();
  await page.getByRole("button",{name:"Browse Lower floor",exact:true}).click();
  await page.getByRole("list",{name:"House items"}).getByRole("button").first().click();
  await expect(page.getByRole("complementary",{name:"Inspector",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Close inspector",exact:true}).click();
  await expect(page.getByRole("complementary",{name:"Inspector",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"View",exact:true}).click();
  const view=page.getByRole("dialog",{name:"View settings",exact:true});
  await expect(view).toBeVisible();
  await expect(view.getByRole("tablist")).toHaveCount(0);
  for(const name of ["Visibility","Cut and separation","Lighting","Appearance","Advanced"])await expect(view.getByText(name,{exact:true})).toBeVisible();
 }finally{await context.close();}
});
