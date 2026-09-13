import {createHash} from "node:crypto";

/** Stable UUID for a resource created by one command; no caller-controlled IDs. */
export function workCommandChildId(ownerId: string, workId: string, commandId: string, purpose: string) {
  const hash = createHash("sha256").update(JSON.stringify(["work-command-child.v1",ownerId.toLowerCase(),workId.toLowerCase(),commandId,purpose])).digest("hex");
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
