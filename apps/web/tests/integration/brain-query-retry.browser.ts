import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "@playwright/test";
import { BrainRecallRetryDetails } from "@/components/brain-recall-retry-details";

const browser=await chromium.launch({headless:true});
const folder=path.resolve("../../docs/research/records");
await mkdir(folder,{recursive:true});
try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const trace={attempts:2,stopReason:"results_available",originalQuery:"项目交付为什么延期？",rewrittenQuery:"项目交付推迟的原因",reason:"使用交付的同义表达，保留原始问题"};
  const markup=renderToStaticMarkup(React.createElement(BrainRecallRetryDetails,{trace}));
  await page.setContent(`<html lang="zh"><head><meta charset="utf-8"><style>body{font:16px/1.6 system-ui;margin:32px;color:#334155}main{max-width:900px;border:1px solid #ddd;padding:24px}details{font-size:14px}summary{cursor:pointer}p{white-space:pre-wrap;overflow-wrap:anywhere}summary:focus-visible{outline:2px solid #2563eb}</style></head><body><main><h1>召回补查 · 隔离组件验收</h1>${markup}</main></body></html>`);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("summary").evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("details").getAttribute("open"),"");
  assert.ok(await page.getByText("补查表达：项目交付推迟的原因").isVisible());
  for(const width of [1280,1024]){
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.locator("details").evaluate(el=>{el.style.fontSize="28px"});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(folder,"memory-query-retry-2026-09-19.png"),fullPage:true});
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("details").getAttribute("open"),null);
  assert.deepEqual(errors,[]);
  const report={passed:true,componentFixture:true,productionPage:false,keyboardDisclosure:true,desktopWidths:[1280,1024],doubleFontNoOverflow:true,pageErrors:errors};
  await writeFile(path.join(folder,"memory-query-retry-browser-2026-09-19.json"),JSON.stringify(report,null,2),"utf8");
  console.log(JSON.stringify(report));
}finally{await browser.close();}
