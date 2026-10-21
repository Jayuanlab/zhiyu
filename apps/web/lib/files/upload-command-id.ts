"use client";

const commands = new WeakMap<File, Map<string, string>>();

/** A retry of the same selected File reuses its command. Different upload
 * purposes have different payloads and must not share a receipt identity. */
export function fileUploadCommandId(file: File, purpose: "saved-file" | "reply-attachment" | "avatar"): string {
  let purposes = commands.get(file);
  if (!purposes) { purposes = new Map(); commands.set(file, purposes); }
  let commandId = purposes.get(purpose);
  if (!commandId) { commandId = crypto.randomUUID(); purposes.set(purpose, commandId); }
  return commandId;
}
