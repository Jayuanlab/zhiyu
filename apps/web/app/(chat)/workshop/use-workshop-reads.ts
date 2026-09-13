"use client";
import {useState,useSyncExternalStore} from 'react';
import {createWorkshopReadClient,emptyWorkshopReads} from '@/lib/workshops/read-client';

export function useWorkshopReads(fetchJson:<T>(url:string)=>Promise<T>) {
  const [client]=useState(()=>createWorkshopReadClient(fetchJson));
  const states=useSyncExternalStore(client.subscribe,client.getSnapshot,()=>emptyWorkshopReads);
  return {read:client.read,states};
}
