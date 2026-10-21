// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { MemoryLessonExtraction, MemoryExtractedLessonReview } from "@/components/memory-lesson-extraction";
let root:Root,container:HTMLDivElement;
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
const quote="Exact original lesson fragment retained.",source={id:"11111111-1111-4111-a111-111111111111",subject:"report",content:`Report\n${quote}\nOther data`,status:"active",revisionVersion:`bmrv1:${"a".repeat(64)}`,extractionSpans:[{offset:7,quote}]};
async function value(element:HTMLTextAreaElement|HTMLInputElement,text:string){await act(async()=>{Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value")!.set!.call(element,text);element.dispatchEvent(new Event("input",{bubbles:true}));});}
it("keeps the source binding and command identity when retrying an uncertain extraction",async()=>{
 const commands:Record<string,unknown>[]=[];vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{commands.push(JSON.parse(String(init.body)));return Response.json({},{status:503});}));
 await act(async()=>root.render(createElement(MemoryLessonExtraction,{source,onSaved:async()=>{}})));
 const inputs=container.querySelectorAll("textarea");for(let i=1;i<inputs.length;i++)await value(inputs[i],`Independent scoped field ${i}`);
 const form=container.querySelector("form")!;await act(async()=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));await act(async()=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(commands).toHaveLength(2);expect(commands[0]).toEqual(commands[1]);expect(commands[0]).toMatchObject({sourceMemoryId:source.id,expectedVersion:source.revisionVersion,quote,offset:7,validityDays:30,conclusion:"Independent scoped field 1"});expect(container.textContent).toContain("重试同一提炼操作");
});
it("shows source failure and prevents confirmation of an unverifiable candidate",async()=>{
 const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);await act(async()=>root.render(createElement(MemoryExtractedLessonReview,{source:{...source,status:"candidate",extractionSourceProblem:"lesson_source_changed_or_unverified",extraction:{sourceMemoryId:source.id,sourceVersion:source.revisionVersion,quote,conditions:"scope",counterexample:"limit",recheckWhen:"change"}},onSaved:async()=>{}})));
 expect(container.textContent).toContain("当前停止召回");const button=Array.from(container.querySelectorAll("button")).find(b=>b.textContent==="确认长期候选")!;expect(button.disabled).toBe(true);await act(async()=>button.click());expect(fetcher).not.toHaveBeenCalled();
});
it("offers evidence repair for an intake with missing sources rather than approving it",async()=>{
 await act(async()=>root.render(createElement(MemoryExtractedLessonReview,{source:{...source,status:"candidate",intake:true,intakeSourceMissing:true,lifecycle:{reviewBy:"2027-01-01T00:00:00Z"}},onSaved:async()=>{}})));
 expect(container.textContent).toContain("缺少可核原始证据");expect(Array.from(container.querySelectorAll("button")).find(b=>b.textContent==="确认长期候选")?.disabled).toBe(true);
});
