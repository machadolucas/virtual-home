"use client";
import { createContext, useContext, type ReactNode } from "react";
const RecordActivity=createContext(true);
export function RecordActivityProvider({active,children}:{active:boolean;children:ReactNode}){return <RecordActivity.Provider value={active}>{children}</RecordActivity.Provider>;}
/** Expensive previews stop when their record or originating hub is parked behind another record. */
export function useRecordActivity(){return useContext(RecordActivity);}
