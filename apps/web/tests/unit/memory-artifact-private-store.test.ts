import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { PrivateLocalObjectStore } from "../../../../packages/storage/src/adapters/private-local";
const key = "00000000-0000-4000-8000-000000000010/00000000-0000-4000-8000-000000000020/00000000-0000-4000-8000-000000000030.bin";
describe("real private local object adapter", () => {
  let root: string, store: PrivateLocalObjectStore;
  beforeEach(() => { root = resolve(process.cwd(), "../../.runtime", `artifact-unit-${randomUUID()}`); store = new PrivateLocalObjectStore(root); });
  afterEach(async () => {
    // Check the resolved absolute target before any Windows recursive cleanup.
    expect(dirname(root)).toBe(resolve(process.cwd(), "../../.runtime")); expect(basename(root)).toMatch(/^artifact-unit-[a-f0-9-]{36}$/);
    await rm(root, { recursive: true, force: true });
  });
  it("publishes a complete immutable object, never overwrites it, and removes temporary siblings", async () => {
    expect(await store.putImmutable(key, new TextEncoder().encode("original"))).toEqual({ created: true });
    expect(await store.putImmutable(key, new TextEncoder().encode("replacement"))).toEqual({ created: false });
    expect(new TextDecoder().decode(await store.read(key, 100))).toBe("original");
    expect(await readdir(resolve(root, "00000000-0000-4000-8000-000000000010/00000000-0000-4000-8000-000000000020"))).toEqual(["00000000-0000-4000-8000-000000000030.bin"]);
  });
  it("has one whole winner for concurrent different byte writes to the same key", async () => {
    const first = new Uint8Array(4096).fill(65), second = new Uint8Array(4096).fill(66);
    const writes = await Promise.all([store.putImmutable(key, first), store.putImmutable(key, second)]);
    expect(writes.filter(value => value.created)).toHaveLength(1);
    const saved = await store.read(key, 4096); expect(saved.every(byte => byte === saved[0])).toBe(true); expect([65, 66]).toContain(saved[0]);
  });
  it("refuses path traversal and HTTP public roots", async () => {
    for (const path of ["../escape", "/absolute", "owner/object.bin", key.replace("/", "\\")]) await expect(store.putImmutable(path, new Uint8Array([1]))).rejects.toThrow();
    expect(() => new PrivateLocalObjectStore(resolve(root, "public"))).toThrow(); expect(() => new PrivateLocalObjectStore("relative")).toThrow();
  });
  it("bounds reads and never recursively removes a non-file target", async () => {
    await store.putImmutable(key, new Uint8Array(16)); await expect(store.read(key, 15)).rejects.toThrow();
    await store.remove(key); await store.remove(key);
    const directoryKey = key.replace("000000000030.bin", "000000000040.bin");
    await mkdir(resolve(root, ...directoryKey.split("/")), { recursive: true });
    await expect(store.remove(directoryKey)).rejects.toThrow(); await expect(store.read(directoryKey, 100)).rejects.toThrow();
  });
  it("retires immutable keys before any late writer can recreate deleted bytes", async () => {
    await store.remove(key);
    await expect(store.putImmutable(key, new Uint8Array([65]))).rejects.toMatchObject({ code: "PRIVATE_OBJECT_RETIRED" });
    await expect(store.read(key, 100)).rejects.toThrow();
  });
  it("keeps bytes unavailable after concurrent cleanup and a different process writer", async () => {
    const other = new PrivateLocalObjectStore(root);
    await Promise.allSettled([store.putImmutable(key, new Uint8Array(8192).fill(65)), other.remove(key)]);
    await expect(store.read(key, 10000)).rejects.toThrow();
    await expect(other.putImmutable(key, new Uint8Array([66]))).rejects.toMatchObject({ code: "PRIVATE_OBJECT_RETIRED" });
  });
  it("removes only this key's abandoned upload bodies after publishing its retirement fence", async () => {
    await store.putImmutable(key, new Uint8Array([65]));
    const target = resolve(root, ...key.split("/")), abandoned = `${target}.upload-${randomUUID()}`, unrelated = `${target}.unrelated`;
    await writeFile(abandoned, new Uint8Array(8192).fill(66)); await writeFile(unrelated, new Uint8Array([67]));
    await store.remove(key);
    await expect(stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" }); expect((await stat(target)).size).toBe(0); expect((await stat(unrelated)).size).toBe(1);
    await expect(store.putImmutable(key, new Uint8Array([68]))).rejects.toMatchObject({ code: "PRIVATE_OBJECT_RETIRED" });
  });
});
