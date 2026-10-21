import { createHash } from "node:crypto";
import { MemoryModuleError } from "../kernel/errors";
import { SUPPORTED_ATTACHMENT_MIME_TYPES } from "@/lib/files/config";
export function artifactDigest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function requireArtifactMedia(type: string) {
  if (!SUPPORTED_ATTACHMENT_MIME_TYPES.some(value => value === type) && !["application/json", "text/csv"].includes(type))
    throw new MemoryModuleError("artifact_media_unsupported", 415, "This artifact media type is not supported");
}
/** Signature-family validation, not a claim that the full document is safe or parsed. */
export function verifyArtifactMedia(bytes: Uint8Array, type: string) {
  requireArtifactMedia(type);
  const hex = Buffer.from(bytes.subarray(0, 16)).toString("hex"), ascii = Buffer.from(bytes.subarray(0, 64)).toString("latin1");
  let valid = false;
  if (type.startsWith("text/") || type === "application/json") {
    try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); valid = !text.includes("\0"); if (type === "application/json") JSON.parse(text); }
    catch { valid = false; }
  } else if (type === "image/png") valid = hex.startsWith("89504e470d0a1a0a");
  else if (type === "image/jpeg") valid = hex.startsWith("ffd8ff");
  else if (type === "image/gif") valid = /^GIF8[79]a/.test(ascii);
  else if (type === "image/webp") valid = ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
  else if (type === "application/pdf") valid = ascii.startsWith("%PDF-");
  else if (type.includes("openxmlformats") || ["application/zip", "application/vnd.apple.pages", "application/vnd.apple.numbers", "application/vnd.apple.keynote"].includes(type)) valid = /^504b(0304|0506|0708)/.test(hex);
  else if (["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(type)) valid = hex.startsWith("d0cf11e0a1b11ae1");
  else if (type === "application/gzip") valid = hex.startsWith("1f8b");
  else if (type === "application/x-bzip2") valid = ascii.startsWith("BZh");
  else if (type === "application/x-7z-compressed") valid = hex.startsWith("377abcaf271c");
  else if (type === "application/vnd.rar") valid = hex.startsWith("526172211a07");
  else if (type === "application/x-tar") valid = Buffer.from(bytes.subarray(257, 262)).toString("ascii") === "ustar";
  else if (type === "audio/wav") valid = ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE";
  else if (type === "audio/flac") valid = ascii.startsWith("fLaC");
  else if (type === "audio/ogg") valid = ascii.startsWith("OggS");
  else if (type === "audio/mpeg") valid = ascii.startsWith("ID3") || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  else if (type === "audio/aac") valid = bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  else if (["video/mp4", "video/quicktime", "audio/mp4"].includes(type)) valid = ascii.slice(4, 8) === "ftyp";
  else if (["video/webm", "video/x-matroska"].includes(type)) valid = hex.startsWith("1a45dfa3");
  else if (type === "video/x-msvideo") valid = ascii.startsWith("RIFF") && ascii.slice(8, 12) === "AVI ";
  if (!valid) throw new MemoryModuleError("artifact_media_mismatch", 415, "The actual artifact bytes do not match their declared media type");
}
