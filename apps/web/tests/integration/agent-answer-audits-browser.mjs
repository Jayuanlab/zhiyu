import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import { startIsolatedPlatformHttpServer } from "../../scripts/lib/platform-eval-v2-http-server.mjs";

const expect = playwrightExpect.configure({ timeout: 90_000 });

/** Synthetic persisted fixtures test the real UI and GET, never model accuracy. */
export async function checkAgentAnswerAuditsBrowser({ databaseUrl, fixtures, folder }) {
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sourceFiles = [
    "tests/integration/agent-answer-audits-browser.mjs", "scripts/lib/platform-eval-v2-http-server.mjs",
    "components/agent/chat-panel.tsx", "components/multimodal-input.tsx", "components/chat-context.tsx",
    "components/message/index.tsx", "components/message/answer-evidence-card.tsx",
    "app/api/native/answer-audits/[turnId]/route.ts", "lib/db/agent-answer-audits.ts", "lib/db/owned-chat-messages.ts",
  ];
  const sourceSnapshot = Object.fromEntries(sourceFiles.map(file => [file, createHash("sha256").update(fs.readFileSync(path.join(web, file))).digest("hex")]));
  const appHome = path.join(folder, "http-home"); fs.mkdirSync(appHome, { recursive: true });
  fs.writeFileSync(path.join(appHome, ".answer-audit-fixture-owner.json"), JSON.stringify({ runFolder: path.resolve(folder), ownerId: fixtures.owner }), "utf8");
  let server, browser;
  const checks = [], requests = { nativeAgentPosts: 0, modelEndpointsBlocked: 0, otherBlockedPosts: 0, saveFailurePosts: 0, auditGets: 0, externalBlocked: 0, allowedApiPaths: [] };
  const report = { status: "running", purpose: "synthetic_desktop_contract", modelCalls: 0, sourceSnapshot, checks, requests, cleanup: { status: "pending" } };
  try {
    server = await startIsolatedPlatformHttpServer({ databaseUrl, ownerId: fixtures.owner, appHome });
    const identityResponse = await fetch(`${server.origin}/api/identity`, { signal: AbortSignal.timeout(120_000) });
    assert.equal(identityResponse.status, 200); assert.equal((await identityResponse.json()).actorId, fixtures.owner);
    const ownerResponse = await fetch(`${server.origin}/api/native/answer-audits/${fixtures.turnId}`, { signal: AbortSignal.timeout(120_000) });
    assert.equal(ownerResponse.status, 200); const owner = await ownerResponse.json();
    assert.equal(owner.chatId, fixtures.chatId); assert.equal(owner.assistantMessageId, fixtures.assistantMessageId);
    assert.equal(owner.evidence.outcome, "supported_fields"); assert.ok(!JSON.stringify(owner).includes("rawDraft"));
    assert.equal(owner.finalText, fixtures.canonicalDisplayText);
    const tamperedResponse = await fetch(`${server.origin}/api/native/answer-audits/${fixtures.tamperedTurnId}`, { signal: AbortSignal.timeout(120_000) });
    assert.equal(tamperedResponse.status, 200); const tamperedAudit = await tamperedResponse.json();
    assert.equal(tamperedAudit.chatId, fixtures.chatId); assert.equal(tamperedAudit.assistantMessageId, fixtures.tamperedAssistantId);
    assert.equal(tamperedAudit.evidence.outcome, "supported_fields"); assert.equal(tamperedAudit.finalText, fixtures.tamperedCanonicalText);
    assert.notEqual(tamperedAudit.finalText, fixtures.tamperedDisplayText);
    const foreignResponse = await fetch(`${server.origin}/api/native/answer-audits/${fixtures.foreignTurnId}`, { signal: AbortSignal.timeout(120_000) });
    assert.equal(foreignResponse.status, 404); checks.push({ id: "real_http_owner_binding", passed: true });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const consoleErrors = []; let saveFailure = false;
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.href.startsWith(server.origin)) { requests.externalBlocked++; return route.abort(); }
      if (/^\/api\/(?:native\/agent|ai\/|chat\/suggestions(?:\/|$))/.test(url.pathname)) { if (url.pathname === "/api/native/agent" && request.method() === "POST") requests.nativeAgentPosts++; requests.modelEndpointsBlocked++; return route.abort(); }
      if (url.pathname.includes("/api/native/answer-audits/")) requests.auditGets++;
      if (request.method() !== "GET" && request.method() !== "HEAD") {
        if (url.pathname === "/api/native/agent") requests.nativeAgentPosts++;
        if (saveFailure && url.pathname === "/api/chat/save-messages") {
          requests.saveFailurePosts++;
          return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic save failure" }) });
        }
        requests.otherBlockedPosts++; return route.abort();
      }
      if (url.pathname.startsWith("/api/") && !requests.allowedApiPaths.includes(url.pathname)) requests.allowedApiPaths.push(url.pathname);
      return route.continue();
    });
    await context.addInitScript(({ chatId }) => { localStorage.setItem("activeChatId", chatId); }, { chatId: fixtures.chatId });
    const page = await context.newPage(); page.on("pageerror", error => consoleErrors.push(error.message));
    await page.goto(`${server.origin}/?page=chat&chatId=${fixtures.chatId}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    const positive = page.getByRole("region", { name: "回答核验状态" }).filter({ has: page.getByText(fixtures.turnId, { exact: true }) });
    // The details element contains the identifier even while collapsed.
    await expect(positive).toBeVisible();
    await expect(positive.getByRole("status")).toHaveText("已核验本次读取到的状态");
    await expect(page.getByText(fixtures.canonicalDisplayText, { exact: true })).toBeVisible();
    const tampered = page.getByRole("region", { name: "回答核验状态" }).filter({ has: page.getByText(fixtures.tamperedTurnId, { exact: true }) });
    await expect(tampered.getByRole("status")).toHaveText("显示正文尚未与核验记录一致");
    await expect(tampered.getByText("任务配置", { exact: true }).locator("..")).toContainText("未核实");
    await expect(tampered.getByText("执行观测", { exact: true }).locator("..")).toContainText("未核实");
    await expect(tampered.getByText("已核验本次读取到的状态", { exact: true })).toHaveCount(0);
    await page.getByText(fixtures.tamperedDisplayText, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(folder, "tampered-body-rejected.png"), fullPage: true });
    checks.push({ id: "valid_owner_turn_ref_with_changed_body_not_verified", passed: true });
    const aborted = page.getByRole("region", { name: "回答核验状态" }).filter({ has: page.getByText(fixtures.abortedTurnId, { exact: true }) });
    await expect(aborted.getByRole("status")).toHaveText("本轮回答已中断");
    await expect(aborted).toContainText("本轮未完成可靠核验交付；相关任务的执行状态和实际效果尚未核实。");
    await expect(aborted.getByText("已核验本次读取到的状态", { exact: true })).toHaveCount(0);
    await expect(aborted.getByText(/运行已停止|Loop.*已停|任务已停/)).toHaveCount(0);
    checks.push({ id: "aborted_answer_does_not_assert_target_loop_stopped", passed: true });
    await positive.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(folder, "desktop-1366.png"), fullPage: true }); checks.push({ id: "desktop_trusted_get_card", passed: true });
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(positive).toBeVisible();
    const bounds = await positive.boundingBox(); assert.ok(bounds && bounds.width > 250 && bounds.x >= 0 && bounds.x + bounds.width <= 1025);
    await page.screenshot({ path: path.join(folder, "desktop-1024.png"), fullPage: true }); checks.push({ id: "desktop_resize_readability", passed: true });
    const details = positive.locator("summary"); await details.focus(); await page.keyboard.press("Enter");
    await expect(positive.getByText(fixtures.turnId, { exact: true })).toBeVisible();
    const refresh = positive.getByRole("button", { name: "刷新核验" }); await refresh.focus();
    const beforeReads = requests.auditGets; await page.keyboard.press("Enter");
    await expect.poll(() => requests.auditGets).toBeGreaterThan(beforeReads); checks.push({ id: "keyboard_expand_refresh", passed: true });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(positive.getByRole("status")).toHaveText("已核验本次读取到的状态"); checks.push({ id: "reload_uses_server_audit", passed: true });

    await page.evaluate(chatId => localStorage.setItem("activeChatId", chatId), fixtures.fakeChatId);
    // addInitScript selects the initial chat at every navigation; use a fresh context for the fake.
    const fakeContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await fakeContext.addInitScript(({ chatId }) => { localStorage.setItem("activeChatId", chatId); }, { chatId: fixtures.fakeChatId });
    await fakeContext.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.href.startsWith(server.origin)) { requests.externalBlocked++; return route.abort(); }
      if (/^\/api\/(?:native\/agent|ai\/|chat\/suggestions(?:\/|$))/.test(url.pathname)) { if (url.pathname === "/api/native/agent" && request.method() === "POST") requests.nativeAgentPosts++; requests.modelEndpointsBlocked++; return route.abort(); }
      if (url.pathname.includes("/api/native/answer-audits/")) requests.auditGets++;
      if (request.method() !== "GET" && request.method() !== "HEAD") { if (url.pathname === "/api/native/agent") requests.nativeAgentPosts++; requests.otherBlockedPosts++; return route.abort(); }
      if (url.pathname.startsWith("/api/") && !requests.allowedApiPaths.includes(url.pathname)) requests.allowedApiPaths.push(url.pathname);
      return route.continue();
    });
    const fakePage = await fakeContext.newPage(); await fakePage.goto(`${server.origin}/?page=chat&chatId=${fixtures.fakeChatId}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    const fakeCards = fakePage.getByRole("region", { name: "回答核验状态" });
    await expect(fakeCards).toHaveCount(2);
    await expect(fakeCards.getByRole("status")).toHaveText(["核验记录暂不可用", "核验记录暂不可用"]);
    await expect(fakePage.getByText("已核验本次读取到的状态", { exact: true })).toHaveCount(0);
    await fakePage.screenshot({ path: path.join(folder, "fake-cache-rejected.png"), fullPage: true }); checks.push({ id: "unknown_and_cross_message_refs_not_verified", passed: true });
    await fakeContext.close();

    saveFailure = true;
    const draft = "隔离保存失败测试：请保留这段输入。";
    const editor = page.locator("textarea").first();
    await expect(editor).toBeVisible(); await editor.fill(draft); await editor.press("Enter");
    await expect.poll(() => requests.saveFailurePosts).toBeGreaterThan(0);
    await expect(editor).toHaveValue(draft); assert.equal(requests.nativeAgentPosts, 0);
    report.saveFailureStateBeforeReload = await page.evaluate(({ chatId }) => ({ globalDraft: localStorage.getItem("input"), chatDraft: localStorage.getItem(`openzhiyu:chat-input-${chatId}`) }), { chatId: fixtures.chatId });
    assert.equal(report.saveFailureStateBeforeReload.chatDraft, draft, "The failed draft must be durable before refresh");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.locator("textarea").first()).toHaveValue(draft);
    await expect(positive.getByRole("status")).toHaveText("已核验本次读取到的状态");
    await expect(page.locator("textarea").first()).toHaveValue(draft); checks.push({ id: "save_failure_preserves_draft_no_model_start", passed: true });
    await page.screenshot({ path: path.join(folder, "save-failure-preserved.png"), fullPage: true });

    // Real chat URL transitions share one browser storage profile. Neither draft
    // may be loaded from the other chat or from the retired global draft cache.
    const secondDraft = "第二个隔离聊天的独立草稿。";
    await page.goto(`${server.origin}/?page=chat&chatId=${fixtures.fakeChatId}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByRole("region", { name: "回答核验状态" })).toHaveCount(2);
    await expect(page.getByRole("region", { name: "回答核验状态" }).getByRole("status")).toHaveText(["核验记录暂不可用", "核验记录暂不可用"]);
    await expect(page.locator("textarea").first()).toHaveValue("");
    await page.locator("textarea").first().fill(secondDraft);
    const storedDrafts = await page.evaluate(({ first, second }) => ({
      first: localStorage.getItem(`openzhiyu:chat-input-${first}`),
      second: localStorage.getItem(`openzhiyu:chat-input-${second}`),
    }), { first: fixtures.chatId, second: fixtures.fakeChatId });
    assert.equal(storedDrafts.first, draft); assert.equal(storedDrafts.second, secondDraft);
    await page.goto(`${server.origin}/?page=chat&chatId=${fixtures.chatId}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(positive.getByRole("status")).toHaveText("已核验本次读取到的状态");
    await expect(page.locator("textarea").first()).toHaveValue(draft);
    await page.goto(`${server.origin}/?page=chat&chatId=${fixtures.fakeChatId}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByRole("region", { name: "回答核验状态" })).toHaveCount(2);
    await expect(page.locator("textarea").first()).toHaveValue(secondDraft);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByRole("region", { name: "回答核验状态" })).toHaveCount(2);
    await expect(page.locator("textarea").first()).toHaveValue(secondDraft);
    checks.push({ id: "two_chat_drafts_isolated_across_url_switch_and_refresh", passed: true });
    assert.equal(requests.nativeAgentPosts, 0);
    for (const file of sourceFiles) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(web, file))).digest("hex"), sourceSnapshot[file], `Source changed during browser check: ${file}`);
    report.status = "passed"; report.pageErrors = consoleErrors;
  } catch (error) {
    report.status = "failed"; report.error = error.message;
    if (browser) for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
      try { await page.screenshot({ path: path.join(folder, `failure-${index}.png`), fullPage: true }); report[`failurePage${index}`] = { url: page.url(), bodyText: (await page.locator("body").innerText()).slice(0, 8000) }; } catch {}
    }
    throw error;
  }
  finally {
    try {
      if (browser) await browser.close(); if (server) await server.stop();
      const relative = path.relative(path.resolve(folder), path.resolve(appHome));
      const marker = JSON.parse(fs.readFileSync(path.join(appHome, ".answer-audit-fixture-owner.json"), "utf8"));
      if (relative !== "http-home" || marker.runFolder !== path.resolve(folder) || marker.ownerId !== fixtures.owner) throw Error("Synthetic profile cleanup ownership mismatch");
      fs.rmSync(appHome, { recursive: true, force: false });
      report.cleanup = { status: "completed", httpStopped: true, profileAbsent: !fs.existsSync(appHome), receiptsPreserved: true };
    }
    catch (error) { report.cleanup = { status: "failed", error: error.message }; throw error; }
    finally { fs.writeFileSync(path.join(folder, "browser.json"), JSON.stringify(report, null, 2), "utf8"); }
  }
  return report;
}
