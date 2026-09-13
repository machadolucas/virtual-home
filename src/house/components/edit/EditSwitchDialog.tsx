"use client";
import { useEffect,useRef,useState } from "react";
import type { HouseRuntime } from "@/house/runtime";
import { Dialog } from "@/ui/Dialog";
import { Button } from "@/ui/Button";
import { registerEditSwitchPrompt,type EditSwitchChoice } from "./confirmSwitch";
export function EditSwitchDialog({runtime}:{runtime:HouseRuntime}){
  const [open,setOpen]=useState(false);const resolve=useRef<((choice:EditSwitchChoice)=>void)|null>(null);
  function choose(choice:EditSwitchChoice){const done=resolve.current;resolve.current=null;setOpen(false);done?.(choice);}
  useEffect(()=>{const remove=registerEditSwitchPrompt(runtime,()=>new Promise(done=>{resolve.current=done;setOpen(true);}));return()=>{remove();resolve.current?.("keep");resolve.current=null;};},[runtime]);
  return <Dialog open={open} onOpenChange={value=>{if(!value)choose("keep");}} title="Save your current edit?" description="Save before switching, discard this draft, or keep editing it." footer={<><Button onClick={()=>choose("keep")}>Keep editing</Button><Button variant="danger" onClick={()=>choose("discard")}>Discard</Button><Button variant="primary" onClick={()=>choose("save")}>Save and continue</Button></>}/>;
}
