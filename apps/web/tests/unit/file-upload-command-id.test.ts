import { describe, expect, it } from "vitest";
import { fileUploadCommandId } from "@/lib/files/upload-command-id";

describe("File upload retry identity", () => {
  it("retains the same command when the same selected file is retried", () => {
    const file = new File(["synthetic"], "fixture.txt", { type: "text/plain" });
    const command = fileUploadCommandId(file, "saved-file");
    expect(fileUploadCommandId(file, "saved-file")).toBe(command);
    expect(command).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("does not confuse another file selection or another upload purpose with a retry", () => {
    const first = new File(["synthetic"], "fixture.txt"), second = new File(["synthetic"], "fixture.txt");
    expect(fileUploadCommandId(second, "saved-file")).not.toBe(fileUploadCommandId(first, "saved-file"));
    expect(fileUploadCommandId(first, "avatar")).not.toBe(fileUploadCommandId(first, "saved-file"));
    expect(fileUploadCommandId(first, "reply-attachment")).not.toBe(fileUploadCommandId(first, "saved-file"));
  });
});
