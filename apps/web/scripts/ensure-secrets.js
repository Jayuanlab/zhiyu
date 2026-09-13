#!/usr/bin/env node
// Automatically generates AUTH_SECRET and ENCRYPTION_KEY in .env if missing

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const envPath = path.join(process.cwd(), ".env");

function generateSecret() {
  return crypto.randomBytes(32).toString("base64");
}

function ensureSecrets() {
  let envContent = "";

  try {
    envContent = fs.readFileSync(envPath, "utf-8");
  } catch {
    // .env doesn't exist yet, start fresh
    envContent = "";
  }

  let updated = false;
  for (const key of ["QUANT_INTERNAL_TOKEN", "WECHAT_DESKTOP_TOKEN"]) {
    if (!new RegExp(`^${key}=.+$`, "m").test(envContent) && !process.env[key]) {
      envContent = envContent.replace(new RegExp(`^${key}=.*(?:\\r?\\n|$)`, "gm"), "");
      envContent += `\n${key}=${generateSecret()}\n`;
      updated = true;
      console.log(`Generated ${key}`);
    }
  }
  const lines = envContent.split("\n");
  const newLines = [];
  let hasAuthSecret = false;
  let hasEncryptionKey = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("AUTH_SECRET=")) {
      hasAuthSecret = true;
      newLines.push(line);
    } else if (trimmed.startsWith("ENCRYPTION_KEY=")) {
      hasEncryptionKey = true;
      newLines.push(line);
    } else {
      newLines.push(line);
    }
  }

  if (!hasAuthSecret) {
    newLines.push(`AUTH_SECRET=${generateSecret()}`);
    updated = true;
    console.log("✅ Generated AUTH_SECRET");
  }

  if (!hasEncryptionKey) {
    newLines.push(`ENCRYPTION_KEY=${generateSecret()}`);
    updated = true;
    console.log("✅ Generated ENCRYPTION_KEY");
  }

  if (updated) {
    // Filter out empty lines at end, then add one newline at end
    while (newLines.length > 0 && newLines[newLines.length - 1] === "") {
      newLines.pop();
    }
    fs.writeFileSync(envPath, `${newLines.join("\n")}\n`);
    console.log("📝 Updated .env file");
  }
}

ensureSecrets();
