"use client";
import type { HouseRuntime } from "@/house/runtime";
import { NewEquipmentForm } from "./NewEquipmentForm";
export function NewTreeForm(props:{runtime:HouseRuntime;onStarted?:()=>void;onCancelled?:()=>void}){return <NewEquipmentForm {...props} tree/>;}
