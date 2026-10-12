import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAppDir } from "../../lib/env/config/constants";

const prior = process.env.ZHIYU_APP_DATA_DIR;
afterEach(() => {
  if (prior === undefined) delete process.env.ZHIYU_APP_DATA_DIR;
  else process.env.ZHIYU_APP_DATA_DIR = prior;
});

describe("Windows distribution data isolation", () => {
  it("keeps the existing default for normal Web users", () => {
    delete process.env.ZHIYU_APP_DATA_DIR;
    expect(getAppDir()).toBe(join(homedir(), ".openzhiyu"));
  });
  it("uses the explicit installation data directory", () => {
    process.env.ZHIYU_APP_DATA_DIR = resolve("isolated-installation", "app-data");
    expect(getAppDir()).toBe(process.env.ZHIYU_APP_DATA_DIR);
  });
  it("rejects ambiguous relative paths", () => {
    process.env.ZHIYU_APP_DATA_DIR = "../another-user";
    expect(() => getAppDir()).toThrow("app_data_directory_must_be_absolute");
  });
});
