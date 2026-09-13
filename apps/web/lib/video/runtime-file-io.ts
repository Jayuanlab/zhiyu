import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// These paths are supplied at runtime, not assets to include in a Next build.
// Keep I/O across a module boundary so NFT cannot expand dynamic user-output
// paths into recursive globs over the project and historical build directories.
export function runtimeFileExists(path: string): boolean {
  return existsSync(path);
}

export async function createRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function readRuntimeText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeRuntimeText(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}
