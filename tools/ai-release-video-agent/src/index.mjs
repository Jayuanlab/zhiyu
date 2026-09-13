#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderEditorialVideo } from "./editorial-renderer.mjs";

const currentDir = dirname(fileURLToPath(import.meta.url));
const toolRoot = resolve(currentDir, "..");

const providerCatalog = {
  "fal:hailuo-02-standard": {
    kind: "image-to-video",
    unit: "second",
    priceUsd: 0.045,
    note: "Good default for animating product screenshots at 768P.",
  },
  "fal:wan-2.5": {
    kind: "text-or-image-to-video",
    unit: "second",
    priceUsd: 0.05,
    note: "Cheap draft and batch exploration model.",
  },
  "fal:kling-2.5-turbo-pro": {
    kind: "text-or-image-to-video",
    unit: "second",
    priceUsd: 0.07,
    note: "Use for shots that need stronger motion and polish.",
  },
  "runway:gen4-turbo": {
    kind: "text-or-image-to-video",
    unit: "second",
    priceUsd: 0.05,
    note: "Good quality API option; check account availability before use.",
  },
};

function parseArgs(argv) {
  const args = {
    command: argv[2],
    projectRoot: resolve(toolRoot, "../.."),
    since: "HEAD~5",
    until: "HEAD",
    profile: resolve(toolRoot, "profiles/project-profile.md"),
    outputRoot: resolve(toolRoot, "outputs"),
    provider: "fal:hailuo-02-standard",
    planner: "bailian",
    envFile: null,
    planDir: null,
    url: "http://127.0.0.1:3515/workshop",
    duration: null,
    width: 1080,
    height: 1920,
    captureWidth: 1440,
    captureHeight: 900,
    layout: "desktop-in-vertical",
    subtitleLanguage: "zh-CN",
    ttsProvider: "edge",
    ttsVoice: "zh-CN-XiaoxiaoNeural",
    useAiVideo: false,
    videoProvider: "mock",
    videoModel: "wan2.7-t2v-2026-06-12",
    videoEndpoint: null,
    videoWorkspaceId: null,
    videoRegion: "cn-beijing",
    videoResolution: "720P",
    videoRatio: null,
    videoWatermark: false,
    reuseAiVideo: false,
    maxAiShots: 2,
    aiFallback: "mock",
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--project-root") {
      args.projectRoot = resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--since") {
      args.since = next;
      i += 1;
    } else if (arg === "--until") {
      args.until = next;
      i += 1;
    } else if (arg === "--profile") {
      args.profile = resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--output-root") {
      args.outputRoot = resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--provider") {
      args.provider = next;
      i += 1;
    } else if (arg === "--planner") {
      args.planner = next;
      i += 1;
    } else if (arg === "--env-file") {
      args.envFile = resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--plan-dir") {
      args.planDir = resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--url") {
      args.url = next;
      i += 1;
    } else if (arg === "--duration") {
      args.duration = Number(next);
      i += 1;
    } else if (arg === "--width") {
      args.width = Number(next);
      i += 1;
    } else if (arg === "--height") {
      args.height = Number(next);
      i += 1;
    } else if (arg === "--capture-width") {
      args.captureWidth = Number(next);
      i += 1;
    } else if (arg === "--capture-height") {
      args.captureHeight = Number(next);
      i += 1;
    } else if (arg === "--layout") {
      args.layout = next;
      i += 1;
    } else if (arg === "--subtitle-language") {
      args.subtitleLanguage = next;
      i += 1;
    } else if (arg === "--tts-provider") {
      args.ttsProvider = next;
      i += 1;
    } else if (arg === "--tts-voice") {
      args.ttsVoice = next;
      i += 1;
    } else if (arg === "--use-ai-video") {
      args.useAiVideo = true;
    } else if (arg === "--video-provider") {
      args.videoProvider = next;
      i += 1;
    } else if (arg === "--video-model") {
      args.videoModel = next;
      i += 1;
    } else if (arg === "--video-endpoint") {
      args.videoEndpoint = next;
      i += 1;
    } else if (arg === "--video-workspace-id") {
      args.videoWorkspaceId = next;
      i += 1;
    } else if (arg === "--video-region") {
      args.videoRegion = next;
      i += 1;
    } else if (arg === "--video-resolution") {
      args.videoResolution = next;
      i += 1;
    } else if (arg === "--video-ratio") {
      args.videoRatio = next;
      i += 1;
    } else if (arg === "--video-watermark") {
      args.videoWatermark = true;
    } else if (arg === "--reuse-ai-video") {
      args.reuseAiVideo = true;
    } else if (arg === "--max-ai-shots") {
      args.maxAiShots = Number(next);
      i += 1;
    } else if (arg === "--ai-fallback") {
      args.aiFallback = next;
      i += 1;
    }
  }

  return args;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function loadProjectEnv(args) {
  const candidates = [
    args.envFile,
    resolve(args.projectRoot, "apps/web/.env"),
    resolve(args.projectRoot, ".env"),
  ].filter(Boolean);

  const loaded = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      if (process.env[parsed.key] === undefined) {
        process.env[parsed.key] = expandEnvValue(parsed.value);
      }
    }
    loaded.push(file);
  }

  return loaded;
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return null;

  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return {
    key: match[1],
    value,
  };
}

function expandEnvValue(value) {
  return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, bareName, bracedName) => {
    const name = bareName || bracedName;
    return process.env[name] ?? "";
  });
}

function runGit(projectRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString()?.trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

async function renderVideo(args) {
  const planDir = args.planDir ?? latestOutputDir(args.outputRoot);
  if (!planDir) {
    throw new Error("No plan output found. Run `node src/index.mjs generate` first.");
  }

  const storyboardPath = resolve(planDir, "storyboard.json");
  const scriptPath = resolve(planDir, "script.md");
  if (!existsSync(storyboardPath)) {
    throw new Error(`Missing storyboard.json in ${planDir}`);
  }

  const storyboard = JSON.parse(stripBom(readFileSync(storyboardPath, "utf8")));
  if (args.useAiVideo && (args.videoProvider === "mock" || storyboard.scenes.some(scene => scene.shot))) {
    return renderEditorialVideo({ storyboard, args, planDir, createVoiceover,
      generateVideo: async ({prompt, outputDir, durationSeconds}) => {
        if (args.videoProvider !== "wan") throw new Error('Generated shots require the configured Wan video provider.');
        return generateWanVideo({prompt, outputDir, durationSeconds, args});
      },
    });
  }
  const script = existsSync(scriptPath)
    ? stripBom(readFileSync(scriptPath, "utf8"))
    : "";
  const localizedStoryboard = await localizeStoryboardForRender({
    storyboard,
    script,
    language: args.subtitleLanguage,
    args,
  });
  const assetsDir = resolve(planDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const plannedDuration =
    Number.isFinite(args.duration) && args.duration > 0
      ? args.duration
      : Number(storyboard.targetLengthSeconds) || totalStoryboardSeconds(storyboard) || 30;
  const voiceoverText = extractVoiceoverText(script, localizedStoryboard);
  const voiceoverTextPath = resolve(assetsDir, "voiceover.txt");
  const captionsPath = resolve(assetsDir, "captions.srt");
  const assCaptionsPath = resolve(assetsDir, "captions.ass");

  writeFileSync(voiceoverTextPath, voiceoverText, "utf8");
  const voiceoverPath = createVoiceover({
    textPath: voiceoverTextPath,
    outputDir: assetsDir,
    provider: args.ttsProvider,
    voice: args.ttsVoice,
  });
  const voiceoverDuration = probeMediaDuration(voiceoverPath);
  if (voiceoverDuration > 180) {
    throw new Error(
      `Voiceover is ${voiceoverDuration.toFixed(1)}s, exceeding the 180s render limit. Shorten the script before rendering.`,
    );
  }
  // Never truncate narration to satisfy a requested duration. The planner should
  // keep scripts concise; the renderer's responsibility is to preserve content.
  const targetDuration = Math.max(
    plannedDuration,
    voiceoverDuration ? voiceoverDuration + 0.35 : 0,
  );
  const timedStoryboard = createTimedStoryboard(localizedStoryboard, targetDuration);
  writeFileSync(captionsPath, createSrt(timedStoryboard, targetDuration), "utf8");
  writeFileSync(
    assCaptionsPath,
    createAss(timedStoryboard, targetDuration, args.width, args.height),
    "utf8",
  );

  const finalPath = resolve(assetsDir, "final.mp4");
  const renderResult = args.useAiVideo
    ? await renderHybridVisualTrack({
        storyboard: timedStoryboard,
        args,
        assetsDir,
        targetDuration,
        planDir,
      })
    : {
        mode: "screen-recording",
        capturePath: await captureProductVideo({
          url: args.url,
          outputDir: assetsDir,
          durationSeconds: targetDuration,
          width: args.captureWidth,
          height: args.captureHeight,
        }),
      };

  if (renderResult.mode === "hybrid") {
    composeVisualTrackWithAudio({
      visualTrackPath: renderResult.visualTrackPath,
      voiceoverPath,
      captionsPath: assCaptionsPath,
      finalPath,
      cwd: planDir,
    });
  } else {
    composeFinalVideo({
      capturePath: renderResult.capturePath,
      voiceoverPath,
      captionsPath: assCaptionsPath,
      finalPath,
      cwd: planDir,
      width: args.width,
      height: args.height,
      layout: args.layout,
    });
  }

  writeFileSync(
    resolve(assetsDir, "render-metadata.json"),
    `${JSON.stringify(
      {
        planDir,
        url: args.url,
        durationSeconds: targetDuration,
        plannedDurationSeconds: plannedDuration,
        voiceoverDurationSeconds: voiceoverDuration,
        outputSize: { width: args.width, height: args.height },
        captureSize: { width: args.captureWidth, height: args.captureHeight },
        layout: args.layout,
        ttsProvider: args.ttsProvider,
        ttsVoice: args.ttsVoice,
        capturePath: renderResult.capturePath ?? null,
        visualTrackPath: renderResult.visualTrackPath ?? null,
        renderMode: renderResult.mode,
        shotManifestPath: renderResult.shotManifestPath ?? null,
        videoProvider: args.useAiVideo ? args.videoProvider : null,
        videoModel: args.useAiVideo ? args.videoModel : null,
        videoRegion: args.useAiVideo && args.videoProvider === "wan" ? args.videoRegion : null,
        videoResolution: args.useAiVideo && args.videoProvider === "wan" ? args.videoResolution : null,
        loadedEnvFiles: args.loadedEnvFiles ?? [],
        voiceoverPath,
        captionsPath,
        assCaptionsPath,
        subtitleLanguage: args.subtitleLanguage,
        finalPath,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    planDir,
    assetsDir,
    finalPath,
  };
}

async function localizeStoryboardForRender({ storyboard, script, language, args }) {
  if (!language || language.toLowerCase() !== "zh-cn") {
    return storyboard;
  }

  if (storyboardLooksChinese(storyboard)) {
    return storyboard;
  }

  try {
    const config = getOpenAiCompatiblePlannerConfig();
    if (!config.apiKey) return heuristicChineseStoryboard(storyboard);

    const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content:
              "你是面向中国用户的产品宣传视频本地化编辑。只返回 JSON，不要 Markdown。",
          },
          {
            role: "user",
            content: `把下面这个 Zhiyu 宣传视频分镜本地化为简体中文。

要求：
- 保留 id、durationSeconds、assetType、visual、videoModel。
- 只把 voiceover 和 caption 改成自然、短促、适合短视频的中文。
- 不要直译，要像中文产品更新视频。
- 每条 caption 尽量 6-16 个汉字，最多两行。
- voiceover 可以稍长，但要口语化。
- 返回形状：{"scenes":[{"id":"...","voiceover":"...","caption":"..."}]}

脚本：
${script}

分镜：
${JSON.stringify(storyboard, null, 2)}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) return heuristicChineseStoryboard(storyboard);

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? parseJsonObject(content) : null;
    const sceneUpdates = Array.isArray(parsed?.scenes) ? parsed.scenes : [];
    if (sceneUpdates.length === 0) return heuristicChineseStoryboard(storyboard);

    const updatesById = new Map(
      sceneUpdates.map((scene) => [scene.id, scene]),
    );

    return {
      ...storyboard,
      scenes: storyboard.scenes.map((scene, index) => {
        const update = updatesById.get(scene.id) ?? sceneUpdates[index];
        return {
          ...scene,
          voiceover: stringOr(update?.voiceover, scene.voiceover),
          caption: stringOr(update?.caption, scene.caption),
        };
      }),
    };
  } catch {
    return heuristicChineseStoryboard(storyboard);
  }
}

function storyboardLooksChinese(storyboard) {
  const text = Array.isArray(storyboard.scenes)
    ? storyboard.scenes.map((scene) => `${scene.caption ?? ""} ${scene.voiceover ?? ""}`).join("\n")
    : "";
  return /[\u4e00-\u9fff]/.test(text);
}

function heuristicChineseStoryboard(storyboard) {
  const fallbackCaptions = [
    "知语更新来了",
    "日常流程更稳定",
    "工作区更清晰",
    "品牌体验更统一",
    "现在就可以体验",
  ];
  const fallbackVoiceovers = [
    "这次知语更新，让你的个人 AI 工作区更稳定，也更顺手。",
    "我们优化了自动任务的恢复体验，让重要流程不容易中断。",
    "界面和使用细节也继续打磨，日常查看和操作更清楚。",
    "图标和品牌视觉完成更新，网页和桌面端看起来更一致。",
    "知语会继续围绕个人 AI 工作流持续迭代。",
  ];

  return {
    ...storyboard,
    scenes: (storyboard.scenes ?? []).map((scene, index) => ({
      ...scene,
      voiceover: fallbackVoiceovers[index] ?? fallbackVoiceovers.at(-1),
      caption: fallbackCaptions[index] ?? fallbackCaptions.at(-1),
    })),
  };
}

function latestOutputDir(outputRoot) {
  if (!existsSync(outputRoot)) return null;
  const entries = execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Get-ChildItem -Directory -LiteralPath '${outputRoot.replace(/'/g, "''")}' | Where-Object { Test-Path (Join-Path $_.FullName 'storyboard.json') } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName`,
  ], { encoding: "utf8" }).trim();
  return entries || null;
}

function totalStoryboardSeconds(storyboard) {
  if (!Array.isArray(storyboard.scenes)) return 0;
  return storyboard.scenes.reduce((sum, scene) => sum + (Number(scene.durationSeconds) || 0), 0);
}

function extractVoiceoverText(script, storyboard) {
  if (Array.isArray(storyboard.scenes)) {
    const storyboardText = storyboard.scenes
      .map((scene) => scene.voiceover)
      .filter((text) => typeof text === "string" && text.trim())
      .join("\n\n");
    if (storyboardText.trim()) return storyboardText;
  }

  const voiceoverMatch = script.match(/##\s*Voiceover\s*([\s\S]*?)(?=\n##\s|\s*$)/i);
  if (voiceoverMatch?.[1]?.trim()) {
    return voiceoverMatch[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("- "))
      .join("\n\n");
  }

  return "Zhiyu release update.";
}

function createTimedStoryboard(storyboard, targetDuration) {
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  if (scenes.length === 0) return storyboard;

  const weights = scenes.map((scene) => {
    const text = `${scene.voiceover || ""} ${scene.caption || ""}`.trim();
    return Math.max(8, text.replace(/\s+/g, "").length);
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || scenes.length;
  const minDuration = Math.min(3, Math.max(1.5, targetDuration / scenes.length / 2));
  const rawDurations = weights.map((weight) => Math.max(minDuration, (targetDuration * weight) / totalWeight));
  const rawTotal = rawDurations.reduce((sum, duration) => sum + duration, 0) || targetDuration;
  const scaledDurations = rawDurations.map((duration) => (duration * targetDuration) / rawTotal);

  let cursor = 0;
  return {
    ...storyboard,
    scenes: scenes.map((scene, index) => {
      const remaining = targetDuration - cursor;
      const duration = index === scenes.length - 1
        ? remaining
        : Math.max(1.5, scaledDurations[index]);
      cursor += duration;
      return {
        ...scene,
        durationSeconds: Number(duration.toFixed(3)),
      };
    }),
  };
}

async function captureProductVideo({
  url,
  outputDir,
  durationSeconds,
  width,
  height,
}) {
  const { chromium } = await import("playwright");
  const videoDir = resolve(outputDir, "playwright-video");
  mkdirSync(videoDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    recordVideo: {
      dir: videoDir,
      size: { width, height },
    },
  });
  await context.addCookies([
    {
      name: "user-cookie:confirm",
      value: "true",
      domain: "127.0.0.1",
      path: "/",
    },
    {
      name: "user-cookie:confirm",
      value: "true",
      domain: "localhost",
      path: "/",
    },
  ]);
  const page = await context.newPage();

  try {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      console.warn(`Page navigation did not finish cleanly, continuing capture: ${error.message}`);
    }
    await page.waitForTimeout(2_000);
    await dismissRecordingOverlays(page);
    await hideRecordingChrome(page);
    await page.waitForTimeout(2_500);
    await page.mouse.move(width * 0.5, height * 0.25);

    const steps = Math.max(3, Math.floor(durationSeconds / 5));
    for (let index = 0; index < steps; index += 1) {
      await page.mouse.wheel(0, Math.round(height * 0.45));
      await page.waitForTimeout(1_400);
      await page.mouse.move(
        Math.round(width * (0.25 + (index % 3) * 0.2)),
        Math.round(height * (0.35 + (index % 2) * 0.18)),
        { steps: 12 },
      );
      await page.waitForTimeout(1_100);
    }

    const remainingMs = Math.max(0, durationSeconds * 1_000 - steps * 2_500 - 2_000);
    if (remainingMs > 0) {
      await page.waitForTimeout(remainingMs);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const videos = execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Get-ChildItem -File -LiteralPath '${videoDir.replace(/'/g, "''")}' -Filter *.webm | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName`,
  ], { encoding: "utf8" }).trim();
  if (!videos) {
    throw new Error("Playwright did not produce a recording.");
  }

  const capturePath = resolve(outputDir, "capture.webm");
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Copy-Item -LiteralPath '${videos.replace(/'/g, "''")}' -Destination '${capturePath.replace(/'/g, "''")}' -Force`,
  ]);
  return capturePath;
}

async function captureProductScreenshot({
  url,
  outputPath,
  width,
  height,
  scene,
}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  await context.addCookies([
    {
      name: "user-cookie:confirm",
      value: "true",
      domain: "127.0.0.1",
      path: "/",
    },
    {
      name: "user-cookie:confirm",
      value: "true",
      domain: "localhost",
      path: "/",
    },
  ]);
  const page = await context.newPage();

  try {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      console.warn(`Page navigation did not finish cleanly, continuing screenshot capture: ${error.message}`);
    }
    await page.waitForTimeout(5_000);
    await dismissRecordingOverlays(page);
    await hideRecordingChrome(page);
    await hideFixedBottomOverlays(page);
    await applySceneCaptureDirectives(page, scene);
    await hideFixedBottomOverlays(page);
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: outputPath, fullPage: false });
  } finally {
    await context.close();
    await browser.close();
  }

  return outputPath;
}

async function applySceneCaptureDirectives(page, scene = {}) {
  if (!scene || typeof scene !== "object") return;

  if (scene.captureAction === "open-create-dialog") {
    await clickFirstVisibleText(page, ["新建车间", "创建车间", "新建智能体", "创建智能体"]);
    await page.waitForTimeout(800);
  }

  if (typeof scene.captureSelector === "string" && scene.captureSelector.trim()) {
    await page.evaluate((selector) => {
      document.querySelector(selector)?.scrollIntoView({
        block: "center",
        inline: "nearest",
      });
    }, scene.captureSelector);
    await page.waitForTimeout(500);
  }

  if (Number.isFinite(scene.captureScrollY)) {
    await page.evaluate((scrollY) => {
      window.scrollTo({ top: scrollY, behavior: "instant" });
      for (const element of Array.from(document.querySelectorAll("body *"))) {
        if (element.scrollHeight > element.clientHeight + 20) {
          element.scrollTop = scrollY;
        }
      }
    }, scene.captureScrollY);
    await page.waitForTimeout(500);
  }
}

async function clickFirstVisibleText(page, labels) {
  for (const label of labels) {
    try {
      const target = page.getByText(label, { exact: false }).first();
      if (await target.isVisible({ timeout: 800 })) {
        await target.click({ timeout: 1_500 });
        return true;
      }
    } catch {
      // Try the next label; scenes should still render if this is unavailable.
    }
  }
  return false;
}

async function dismissRecordingOverlays(page) {
  for (const label of ["接受全部", "仅必要", "Accept all", "Accept All"]) {
    try {
      const button = page.getByText(label, { exact: true }).first();
      if (await button.isVisible({ timeout: 800 })) {
        await button.click({ timeout: 1_500 });
        break;
      }
    } catch {
      // Best-effort cleanup for recording-only UI.
    }
  }
}

async function hideRecordingChrome(page) {
  try {
    await page.addStyleTag({
      content: `
        body * {
          --recording-cleanup: 1;
        }
      `,
    });
    await page.evaluate(() => {
      const noisyText = ["我们使用 Cookie", "接受全部", "仅必要", "Rendering", "Compiling"];
      for (const element of Array.from(document.querySelectorAll("body *"))) {
        const text = element.textContent || "";
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const isBottomOverlay =
          style.position === "fixed" &&
          rect.bottom > window.innerHeight - 180 &&
          rect.height > 20;
        if (isBottomOverlay && noisyText.some((token) => text.includes(token))) {
          element.style.setProperty("display", "none", "important");
        }
      }
    });
  } catch {
    // Recording cleanup is best-effort; never fail the render for UI chrome.
  }
}

async function hideFixedBottomOverlays(page) {
  try {
    await page.evaluate(() => {
      const roots = [document];
      for (const element of Array.from(document.querySelectorAll("body *"))) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }

      for (const root of roots) {
        for (const element of Array.from(root.querySelectorAll("*"))) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = element.textContent || "";
        const zIndex = Number.parseInt(style.zIndex, 10);
        const isBottomChrome =
          style.position === "fixed" &&
          rect.bottom > window.innerHeight - 24 &&
          rect.height >= 16 &&
          rect.height <= 180 &&
          rect.width >= 24 &&
          (Number.isFinite(zIndex) ? zIndex >= 10 : true);
        const isNextDevChrome =
          style.position === "fixed" &&
          rect.left < 140 &&
          rect.bottom > window.innerHeight - 140 &&
          rect.width <= 180 &&
          rect.height <= 120 &&
          (text.includes("Rendering") || text.includes("Compiling") || text.trim() === "N");
        const isSmallBottomLeftChrome =
          style.position === "fixed" &&
          rect.left < 90 &&
          rect.bottom > window.innerHeight - 90 &&
          rect.width <= 90 &&
          rect.height <= 90;
        if (isBottomChrome || isNextDevChrome) {
          element.style.setProperty("display", "none", "important");
        }
        if (isSmallBottomLeftChrome) {
          element.style.setProperty("opacity", "0", "important");
          element.style.setProperty("pointer-events", "none", "important");
        }
      }
      }
    });
  } catch {
    // Recording cleanup is best-effort; never fail the render for UI chrome.
  }
}

async function renderHybridVisualTrack({
  storyboard,
  args,
  assetsDir,
  targetDuration,
  planDir,
}) {
  const shotsDir = resolve(assetsDir, "shots");
  mkdirSync(shotsDir, { recursive: true });
  const scenes = normalizeRenderScenes(storyboard, targetDuration);
  const aiShotIds = selectAiShotIds(scenes, args.maxAiShots);
  const renderedShots = [];

  for (const [index, scene] of scenes.entries()) {
    const shotDir = resolve(shotsDir, `${String(index + 1).padStart(2, "0")}-${scene.id}`);
    mkdirSync(shotDir, { recursive: true });
    const shouldUseAi = aiShotIds.has(scene.id);
    const shotPath = shouldUseAi
      ? await renderAiVideoShot({
          scene,
          shotDir,
          args,
          width: args.width,
          height: args.height,
          sceneIndex: index,
          sceneCount: scenes.length,
        })
      : await renderScreenRecordingShot({
          scene,
          shotDir,
          args,
          width: args.width,
          height: args.height,
        });

    renderedShots.push({
      id: scene.id,
      type: shouldUseAi ? "ai-video" : "screen-recording",
      provider: shouldUseAi ? args.videoProvider : null,
      model: shouldUseAi ? args.videoModel : null,
      durationSeconds: scene.durationSeconds,
      prompt: shouldUseAi ? createAiVideoPrompt(scene, { width: args.width, height: args.height }) : null,
      path: shotPath,
    });
  }

  const visualTrackPath = resolve(assetsDir, "visual-track.mp4");
  concatVideoClips(renderedShots.map((shot) => shot.path), visualTrackPath, planDir);
  const shotManifestPath = resolve(assetsDir, "shot-manifest.json");
  writeFileSync(
    shotManifestPath,
    `${JSON.stringify(
      {
        strategy: "hybrid",
        aiShotCount: renderedShots.filter((shot) => shot.type === "ai-video").length,
        screenShotCount: renderedShots.filter((shot) => shot.type === "screen-recording").length,
        shots: renderedShots,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    mode: "hybrid",
    visualTrackPath,
    shotManifestPath,
  };
}

function normalizeRenderScenes(storyboard, targetDuration) {
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  if (scenes.length === 0) {
    return [
      {
        id: "scene-01",
        durationSeconds: targetDuration,
        visual: "Zhiyu release update",
        caption: "知语更新来了",
        voiceover: "知语更新来了。",
      },
    ];
  }

  const storyboardDuration = totalStoryboardSeconds(storyboard) || targetDuration;
  const scale = targetDuration > storyboardDuration ? targetDuration / storyboardDuration : 1;
  return scenes.map((scene, index) => ({
    ...scene,
    id: scene.id || `scene-${String(index + 1).padStart(2, "0")}`,
    durationSeconds: Math.max(2, Number(scene.durationSeconds) * scale || targetDuration / scenes.length),
  }));
}

function selectAiShotIds(scenes, maxAiShots) {
  const limit = Number.isFinite(maxAiShots) && maxAiShots > 0 ? maxAiShots : 2;
  const candidates = scenes.filter((scene) => {
    const assetType = String(scene.assetType ?? "").toLowerCase();
    return scene.videoModel || assetType.includes("ai") || assetType.includes("motion");
  });
  const fallback = candidates.length > 0 ? candidates : scenes.filter((_scene, index) => index === 0 || index === scenes.length - 1);
  return new Set(fallback.slice(0, limit).map((scene) => scene.id));
}

async function renderScreenRecordingShot({ scene, shotDir, args, width, height }) {
  const screenshotPath = await captureProductScreenshot({
    url: scene.url || args.url,
    outputPath: resolve(shotDir, "screen-shot.png"),
    width: args.captureWidth,
    height: args.captureHeight,
    scene,
  });
  const outputPath = resolve(shotDir, "screen-shot.mp4");
  createVideoFromScreenshot({
    inputPath: screenshotPath,
    outputPath,
    width,
    height,
    layout: args.layout,
    cwd: shotDir,
    durationSeconds: scene.durationSeconds,
  });
  return outputPath;
}

async function renderAiVideoShot({
  scene,
  shotDir,
  args,
  width,
  height,
  sceneIndex = 0,
  sceneCount = 1,
}) {
  const prompt = createAiVideoPrompt(scene, { width, height });
  const promptPath = resolve(shotDir, "prompt.txt");
  writeFileSync(promptPath, prompt, "utf8");
  const existingAiShotPath = args.reuseAiVideo ? findReusableAiShot(shotDir, scene.id) : null;
  if (existingAiShotPath) {
    const normalizedPath = resolve(shotDir, "ai-shot-normalized.mp4");
    normalizeVisualClip({
      inputPath: existingAiShotPath,
      outputPath: normalizedPath,
      width,
      height,
      layout: "crop",
      cwd: shotDir,
      durationSeconds: scene.durationSeconds,
    });
    return normalizedPath;
  }

  try {
    if (args.videoProvider === "wan") {
      const generatedPath = await generateWanVideo({
        prompt,
        outputDir: shotDir,
        durationSeconds: scene.durationSeconds,
        args,
      });
      const normalizedPath = resolve(shotDir, "ai-shot.mp4");
      normalizeVisualClip({
        inputPath: generatedPath,
        outputPath: normalizedPath,
        width,
        height,
        layout: "crop",
        cwd: shotDir,
        durationSeconds: scene.durationSeconds,
      });
      return normalizedPath;
    }
    if (args.videoProvider !== "mock") {
      throw new Error(`Unsupported video provider: ${args.videoProvider}`);
    }
  } catch (error) {
    if (args.aiFallback !== "mock") {
      throw error;
    }
    console.warn(`AI video provider failed, using mock shot: ${error.message}`);
  }

  return createMockAiVideoShot({
    scene,
    outputPath: resolve(shotDir, "ai-shot-mock.mp4"),
    width,
    height,
    durationSeconds: scene.durationSeconds,
    sceneIndex,
    sceneCount,
  });
}

function findReusableAiShot(shotDir, sceneId) {
  const currentShotPath = resolve(shotDir, "ai-shot.mp4");
  if (existsSync(currentShotPath)) return currentShotPath;

  const shotsRoot = dirname(shotDir);
  const candidates = [];
  try {
    for (const entry of readdirSync(shotsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(`-${sceneId}`)) continue;
      const candidateDir = resolve(shotsRoot, entry.name);
      candidates.push(resolve(candidateDir, "ai-shot.mp4"));
      candidates.push(resolve(candidateDir, "ai-shot-normalized.mp4"));
    }
  } catch {
    return null;
  }

  return candidates.find((candidatePath) => existsSync(candidatePath)) ?? null;
}

function createAiVideoPrompt(scene, { width = 1080, height = 1920 } = {}) {
  const caption = scene.caption || scene.voiceover || "知语产品更新";
  const visual = scene.visual || "";
  const isLandscape = width >= height;
  const format = isLandscape ? "横屏 16:9" : "竖屏 9:16";
  return [
    `${format} 中文 SaaS 产品宣传片镜头，干净明亮，克制科技感，真实产品更新氛围。`,
    "不要生成可读的具体 UI 文本，不要出现乱码，不要出现英文大段文字；界面内容用抽象卡片、线条、状态变化表达。",
    "画面可以表现信息流、任务卡片、智能体工作空间、记忆沉淀、审批边界和长期任务运转的抽象动效。",
    `镜头主题：${caption}`,
    visual ? `参考画面描述：${visual}` : "",
  ].filter(Boolean).join("\n");
}

async function generateWanVideo({ prompt, outputDir, durationSeconds, args }) {
  const endpoint = getWanVideoEndpoint(args);
  const apiKey = getWanVideoApiKey();
  if (!endpoint || !apiKey) {
    throw new Error("Wan video provider is not configured. Set AI_VIDEO_AGENT_VIDEO_API_KEY plus AI_VIDEO_AGENT_VIDEO_WORKSPACE_ID, or set AI_VIDEO_AGENT_VIDEO_ENDPOINT.");
  }

  const requestBody = buildWanRequestBody({ prompt, durationSeconds, args });
  writeFileSync(resolve(outputDir, "wan-request.json"), JSON.stringify({
    endpoint,
    model: requestBody.model,
    input: requestBody.input,
    parameters: requestBody.parameters,
  }, null, 2));

  const createResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(requestBody),
  });

  const createBody = await createResponse.text();
  writeFileSync(resolve(outputDir, "wan-create-response.json"), createBody);
  if (!createResponse.ok) {
    throw new Error(`Wan task creation failed: HTTP ${createResponse.status} ${createBody.slice(0, 500)}`);
  }

  const createData = parseJsonObject(createBody);
  const taskId = createData?.output?.task_id ?? createData?.task_id;
  if (!taskId) {
    throw new Error(`Wan task response did not include task_id: ${createBody.slice(0, 500)}`);
  }

  const taskUrl = getWanTaskUrl(endpoint, taskId);
  const videoUrl = await pollWanVideoUrl({ taskUrl, apiKey, taskId, outputDir });
  const outputPath = resolve(outputDir, "wan-generated.mp4");
  await downloadFile(videoUrl, outputPath);
  return outputPath;
}

function buildWanRequestBody({ prompt, durationSeconds, args }) {
  const model = args.videoModel || "wan2.7-t2v-2026-06-12";
  const ratio = args.videoRatio || (args.width >= args.height ? "16:9" : "9:16");
  const parameters = {
    resolution: args.videoResolution || "720P",
    ratio,
    duration: Math.min(15, Math.max(2, Math.round(durationSeconds))),
    prompt_extend: true,
    watermark: Boolean(args.videoWatermark),
  };

  if (!String(model).startsWith("wan2.7")) {
    parameters.size = ratio === "16:9" ? "1280*720" : "720*1280";
  }

  return {
    model,
    input: { prompt },
    parameters,
  };
}

function getWanVideoEndpoint(args) {
  const explicitEndpoint = args.videoEndpoint
    ?? firstPresentEnv([
      "AI_VIDEO_AGENT_VIDEO_ENDPOINT",
      "AI_VIDEO_AGENT_WAN_ENDPOINT",
      "DASHSCOPE_VIDEO_ENDPOINT",
      "BAILIAN_VIDEO_ENDPOINT",
    ]);
  if (explicitEndpoint) return explicitEndpoint;

  const baseUrl = firstPresentEnv([
    "AI_VIDEO_AGENT_VIDEO_BASE_URL",
    "AI_VIDEO_AGENT_WAN_BASE_URL",
    "DASHSCOPE_VIDEO_BASE_URL",
    "BAILIAN_VIDEO_BASE_URL",
  ]);
  if (baseUrl) {
    return `${baseUrl.replace(/\/+$/, "")}/services/aigc/video-generation/video-synthesis`;
  }

  const workspaceId = args.videoWorkspaceId
    ?? firstPresentEnv([
      "AI_VIDEO_AGENT_VIDEO_WORKSPACE_ID",
      "AI_VIDEO_AGENT_WAN_WORKSPACE_ID",
      "DASHSCOPE_WORKSPACE_ID",
      "BAILIAN_WORKSPACE_ID",
    ]);
  const region = args.videoRegion
    ?? firstPresentEnv([
      "AI_VIDEO_AGENT_VIDEO_REGION",
      "AI_VIDEO_AGENT_WAN_REGION",
      "DASHSCOPE_REGION",
      "BAILIAN_REGION",
    ])
    ?? "cn-beijing";
  if (!workspaceId) {
    const publicHost = getWanPublicRegionHost(region);
    if (!publicHost) return null;
    return `https://${publicHost}/api/v1/services/aigc/video-generation/video-synthesis`;
  }

  const regionHost = getWanRegionHost(region);
  return `https://${workspaceId}.${regionHost}/api/v1/services/aigc/video-generation/video-synthesis`;
}

function getWanVideoApiKey() {
  return firstPresentEnv([
    "AI_VIDEO_AGENT_VIDEO_API_KEY",
    "AI_VIDEO_AGENT_WAN_API_KEY",
    "AI_VIDEO_AGENT_LLM_API_KEY",
    "WORKSHOP_PLANNER_LLM_API_KEY",
    "INTERACTION_PROCESSOR_LLM_API_KEY",
    "DASHSCOPE_API_KEY",
    "BAILIAN_API_KEY",
  ]);
}

function getWanRegionHost(region) {
  const normalized = String(region || "cn-beijing").trim();
  const hostByRegion = {
    "cn-beijing": "cn-beijing.maas.aliyuncs.com",
    "ap-southeast-1": "ap-southeast-1.maas.aliyuncs.com",
    "eu-central-1": "eu-central-1.maas.aliyuncs.com",
  };
  return hostByRegion[normalized] || `${normalized}.maas.aliyuncs.com`;
}

function getWanPublicRegionHost(region) {
  const normalized = String(region || "cn-beijing").trim();
  const hostByRegion = {
    "cn-beijing": "dashscope.aliyuncs.com",
    "ap-southeast-1": "dashscope-intl.aliyuncs.com",
  };
  return hostByRegion[normalized] || null;
}

function getWanTaskUrl(endpoint, taskId) {
  const marker = "/api/v1/";
  const index = endpoint.indexOf(marker);
  if (index === -1) {
    return `${endpoint.replace(/\/+$/, "")}/tasks/${taskId}`;
  }
  return `${endpoint.slice(0, index + marker.length)}tasks/${taskId}`;
}

async function pollWanVideoUrl({ taskUrl, apiKey, taskId, outputDir }) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let latestBody = "";
  while (Date.now() < deadline) {
    const response = await fetch(taskUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const body = await response.text();
    latestBody = body;
    if (!response.ok) {
      throw new Error(`Wan task poll failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    }
    const data = parseJsonObject(body);
    const status = data?.output?.task_status ?? data?.task_status ?? data?.status;
    const videoUrl =
      data?.output?.video_url
      ?? data?.output?.results?.[0]?.url
      ?? data?.output?.results?.[0]?.video_url
      ?? data?.video_url;

    if (videoUrl) {
      writeFileSync(resolve(outputDir, "wan-task-result.json"), body);
      return videoUrl;
    }
    if (["FAILED", "CANCELED", "UNKNOWN"].includes(String(status).toUpperCase())) {
      writeFileSync(resolve(outputDir, "wan-task-result.json"), body);
      throw new Error(`Wan task ${taskId} ended with status ${status}: ${body.slice(0, 500)}`);
    }
    await sleep(8_000);
  }
  if (latestBody) {
    writeFileSync(resolve(outputDir, "wan-task-result.json"), latestBody);
  }
  throw new Error(`Wan task ${taskId} timed out`);
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function createMockAiVideoShot({
  scene,
  outputPath,
  width,
  height,
  durationSeconds,
  sceneIndex,
  sceneCount,
}) {
  const screenshotPath = resolve(dirname(outputPath), "knowledge-card.png");
  await captureKnowledgeCard({
    scene,
    outputPath: screenshotPath,
    width,
    height,
    sceneIndex,
    sceneCount,
  });
  createMotionVideoFromScreenshot({
    inputPath: screenshotPath,
    outputPath,
    width,
    height,
    cwd: dirname(outputPath),
    durationSeconds,
  });
  return outputPath;
}

async function captureKnowledgeCard({
  scene,
  outputPath,
  width,
  height,
  sceneIndex,
  sceneCount,
}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const captionLines = String(scene.caption || "知识速览")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const title = captionLines[0] || "知识速览";
  const kicker = captionLines.slice(1).join(" · ") || "值得关注的新变化";
  const detail = String(scene.visual || scene.voiceover || "")
    .replace(/[“”'\"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const steps = detail.includes("→")
    ? detail.split("→").map((item) => item.trim()).filter(Boolean).slice(0, 4)
    : [];
  const palettes = [
    ["#7c5cff", "#32d6c5", "#111427"],
    ["#ff7a59", "#ffc857", "#17121c"],
    ["#4f8cff", "#55d6be", "#0d1727"],
    ["#e95f91", "#8b7cff", "#171126"],
    ["#35b978", "#aad45c", "#0d1b19"],
  ];
  const [accent, accentTwo, background] = palettes[sceneIndex % palettes.length];
  const progress = Array.from({ length: sceneCount }, (_, index) =>
    `<span class="dot ${index === sceneIndex ? "active" : ""}"></span>`,
  ).join("");
  const flow = steps.length >= 2
    ? `<div class="flow">${steps.map((step, index) => `<div class="flow-step"><b>0${index + 1}</b><span>${escapeHtml(step)}</span></div>`).join("")}</div>`
    : `<div class="insight"><span class="quote">“</span><p>${escapeHtml(detail)}</p></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif;color:#f7f8ff;background:${background}}
    .page{position:relative;width:100%;height:100%;padding:${Math.round(width * .09)}px;overflow:hidden;background:
      radial-gradient(circle at 85% 12%,${accent}55 0,transparent 34%),
      radial-gradient(circle at 4% 82%,${accentTwo}33 0,transparent 38%),${background}}
    .grid{position:absolute;inset:0;opacity:.1;background-image:linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px);background-size:44px 44px;mask-image:linear-gradient(to bottom,black,transparent 78%)}
    .orb{position:absolute;right:-80px;top:310px;width:310px;height:310px;border:1px solid ${accent}88;border-radius:50%;box-shadow:0 0 80px ${accent}55 inset,0 0 80px ${accent}22}
    .header{position:relative;display:flex;align-items:center;justify-content:space-between;font-size:${Math.round(width*.025)}px;letter-spacing:.18em;color:#cdd2e5}
    .brand{display:flex;gap:10px;align-items:center}.brand:before{content:"";width:11px;height:11px;background:${accentTwo};border-radius:50%;box-shadow:0 0 16px ${accentTwo}}
    .number{font-size:${Math.round(width*.09)}px;font-weight:800;color:#ffffff18;line-height:1}
    .hero{position:relative;margin-top:${Math.round(height*.08)}px;max-width:94%}
    .eyebrow{display:inline-block;padding:9px 15px;border:1px solid ${accent}aa;border-radius:999px;color:${accentTwo};font-size:${Math.round(width*.027)}px;font-weight:700;letter-spacing:.08em;background:#ffffff09}
    h1{margin:24px 0 12px;font-size:${Math.round(width*.085)}px;line-height:1.16;letter-spacing:-.04em;text-wrap:balance}
    .kicker{font-size:${Math.round(width*.034)}px;line-height:1.55;color:#cbd1e3;max-width:88%}
    .rule{margin:34px 0 30px;width:72px;height:5px;border-radius:4px;background:linear-gradient(90deg,${accent},${accentTwo})}
    .insight{position:relative;padding:34px 32px 34px 42px;border:1px solid #ffffff22;border-radius:28px;background:#ffffff0d;backdrop-filter:blur(12px);box-shadow:0 24px 70px #00000033}
    .insight p{margin:0;font-size:${Math.round(width*.037)}px;line-height:1.72;color:#edf0fa}.quote{position:absolute;left:14px;top:4px;font:700 ${Math.round(width*.10)}px Georgia;color:${accent}}
    .flow{display:grid;gap:15px}.flow-step{display:flex;gap:20px;align-items:center;padding:21px 24px;border-radius:22px;background:#ffffff0d;border:1px solid #ffffff1f;font-size:${Math.round(width*.035)}px;line-height:1.45}
    .flow-step b{display:grid;place-items:center;flex:0 0 48px;height:48px;border-radius:15px;background:linear-gradient(135deg,${accent},${accentTwo});font-size:${Math.round(width*.025)}px;color:white}
    .footer{position:absolute;left:${Math.round(width*.09)}px;right:${Math.round(width*.09)}px;bottom:${Math.round(height*.07)}px;display:flex;align-items:center;justify-content:space-between;color:#9ca5bf;font-size:${Math.round(width*.023)}px}
    .dots{display:flex;gap:8px}.dot{width:8px;height:8px;border-radius:99px;background:#ffffff30}.dot.active{width:27px;background:${accentTwo}}
  </style></head><body><main class="page"><div class="grid"></div><div class="orb"></div>
    <header class="header"><div class="brand">ZHIYU · AI KNOWLEDGE</div><div class="number">${String(sceneIndex + 1).padStart(2, "0")}</div></header>
    <section class="hero"><div class="eyebrow">AI 前沿速览</div><h1>${escapeHtml(title)}</h1><div class="kicker">${escapeHtml(kicker)}</div><div class="rule"></div>${flow}</section>
    <footer class="footer"><span>来源核验 · AI 辅助整理</span><div class="dots">${progress}</div></footer>
  </main></body></html>`;
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: outputPath, fullPage: false });
  } finally {
    await browser.close();
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function createMotionVideoFromScreenshot({
  inputPath,
  outputPath,
  width,
  height,
  cwd,
  durationSeconds,
}) {
  const frames = Math.max(1, Math.round(durationSeconds * 25));
  const filter = [
    `scale=${Math.round(width * 1.08)}:${Math.round(height * 1.08)}`,
    `zoompan=z='min(zoom+0.00025,1.04)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=25`,
    "format=yuv420p",
  ].join(",");
  execFileSync("ffmpeg", [
    "-y", "-loop", "1", "-i", inputPath,
    "-t", String(durationSeconds), "-vf", filter,
    "-an", "-r", "25", "-c:v", "libx264", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", outputPath,
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function createVoiceover({
  textPath,
  outputDir,
  provider,
  voice,
}) {
  if (provider === "edge") {
    const outputPath = resolve(outputDir, "voiceover.mp3");
    try {
      removeIfExists(resolve(outputDir, "voiceover.wav"));
      createEdgeVoiceover({
        textPath,
        outputPath,
        voice,
      });
      return outputPath;
    } catch (error) {
      console.warn(`Edge TTS failed, falling back to Windows SAPI: ${error.message}`);
    }
  }

  const outputPath = resolve(outputDir, "voiceover.wav");
  removeIfExists(resolve(outputDir, "voiceover.mp3"));
  createSapiVoiceover({
    textPath,
    outputPath,
  });
  return outputPath;
}

function removeIfExists(filePath) {
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

function createEdgeVoiceover({ textPath, outputPath, voice }) {
  const text = readFileSync(textPath, "utf8").replace(/\s+/g, " ").trim();
  const venvNames = [".venv312", ".venv"];
  const localPython = venvNames
    .map((name) => process.platform === "win32"
      ? resolve(toolRoot, name, "Scripts", "python.exe")
      : resolve(toolRoot, name, "bin", "python"))
    .find((candidate) => existsSync(candidate));
  execFileSync(localPython || "python", [
    "-m",
    "edge_tts",
    "--voice",
    voice || "zh-CN-XiaoxiaoNeural",
    "--rate",
    "+8%",
    "--text",
    text,
    "--write-media",
    outputPath,
    "--write-subtitles",
    resolve(dirname(outputPath), "voiceover.srt"),
  ], { windowsHide: true, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
}

function createSapiVoiceover({ textPath, outputPath }) {
  const psPath = resolve(dirname(outputPath), "make-voiceover.ps1");
  writeFileSync(
    psPath,
    `$ErrorActionPreference = "Stop"\n` +
      `Add-Type -AssemblyName System.Speech\n` +
      `$text = Get-Content -LiteralPath "${escapePowerShellString(textPath)}" -Raw\n` +
      `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer\n` +
      `$synth.Rate = 0\n` +
      `$synth.Volume = 95\n` +
      `$synth.SetOutputToWaveFile("${escapePowerShellString(outputPath)}")\n` +
      `$synth.Speak($text)\n` +
      `$synth.Dispose()\n`,
    "utf8",
  );
  execFileSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    psPath,
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

function probeMediaDuration(filePath) {
  try {
    const output = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { encoding: "utf8" }).trim();
    const duration = Number(output);
    return Number.isFinite(duration) ? duration : 0;
  } catch {
    return 0;
  }
}

function createSrt(storyboard, targetDuration) {
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  if (scenes.length === 0) {
    return `1\n00:00:00,000 --> ${formatSrtTime(targetDuration)}\nOpenZhiYu release update\n`;
  }

  return createNarrationCaptionEvents(scenes, targetDuration)
    .map((event, index) =>
      `${index + 1}\n${formatSrtTime(event.start)} --> ${formatSrtTime(event.end)}\n${wrapCaption(event.text)}\n`,
    )
    .join("\n");
}

function createAss(storyboard, targetDuration, width, height) {
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  const fontSize = width >= height
    ? Math.max(34, Math.round(width * 0.026))
    : Math.max(32, Math.round(width * 0.042));
  const marginV = width >= height ? Math.round(height * 0.075) : Math.round(height * 0.09);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Microsoft YaHei,${fontSize},&H00FFFFFF,&H000000FF,&H00101524,&H70101524,1,0,0,0,100,100,0,0,3,8,0,2,72,72,${marginV},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  if (scenes.length === 0) {
    return `${header}Dialogue: 0,0:00:00.00,${formatAssTime(targetDuration)},Default,,0,0,0,,Zhiyu release update\n`;
  }

  const events = createNarrationCaptionEvents(scenes, targetDuration).map((event) => {
    const caption = wrapCaption(event.text)
      .replace(/\n/g, "\\N")
      .replace(/[{}]/g, "");
    return `Dialogue: 0,${formatAssTime(event.start)},${formatAssTime(event.end)},Default,,0,0,0,,${caption}`;
  });

  return `${header}${events.join("\n")}\n`;
}

function createNarrationCaptionEvents(scenes, targetDuration) {
  const events = [];
  let sceneCursor = 0;
  for (const [sceneIndex, scene] of scenes.entries()) {
    const duration = Number(scene.durationSeconds) || targetDuration / scenes.length;
    const sceneEnd = Math.min(targetDuration, sceneCursor + duration);
    const narration = String(
      scene.voiceover || scene.caption || `Scene ${sceneIndex + 1}`,
    ).replace(/\s+/g, " ").trim();
    const phrases = narration
      .split(/(?<=[。！？；!?;])/u)
      .flatMap((phrase) => splitCaptionPhrase(phrase.trim(), 28))
      .filter(Boolean);
    const weights = phrases.map((phrase) => Math.max(1, phrase.replace(/\s+/g, "").length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let phraseCursor = sceneCursor;
    phrases.forEach((phrase, index) => {
      const remaining = sceneEnd - phraseCursor;
      const phraseDuration = index === phrases.length - 1
        ? remaining
        : ((sceneEnd - sceneCursor) * weights[index]) / totalWeight;
      const end = Math.min(sceneEnd, phraseCursor + phraseDuration);
      events.push({ start: phraseCursor, end, text: phrase });
      phraseCursor = end;
    });
    sceneCursor = sceneEnd;
  }
  return events;
}

function splitCaptionPhrase(text, maxLength) {
  if (!text || text.length <= maxLength) return text ? [text] : [];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    const breakAt = Math.max(
      window.lastIndexOf("，"),
      window.lastIndexOf(","),
      window.lastIndexOf("、"),
      window.lastIndexOf(" "),
    );
    const cut = breakAt >= Math.round(maxLength * 0.55) ? breakAt + 1 : maxLength;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function formatAssTime(seconds) {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function wrapCaption(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= 38) return clean;
  if (!clean.includes(" ")) {
    return chunkCaption(clean, 24, 3).join("\n");
  }
  const words = clean.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length > 38) {
      if (line.trim()) lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join("\n");
}

function chunkCaption(text, size, maxLines) {
  const chunks = [];
  for (let index = 0; index < text.length && chunks.length < maxLines; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  if (chunks.length > 1 && chunks.at(-1).length <= 2) {
    chunks[chunks.length - 2] += chunks.pop();
  }
  return chunks;
}

function composeFinalVideo({
  capturePath,
  voiceoverPath,
  captionsPath,
  finalPath,
  cwd,
  width,
  height,
  layout,
}) {
  const relativeCaptionPath = `assets/${basename(captionsPath)}`;
  const vf =
    layout === "desktop-in-vertical"
      ? [
          "split=2[bg][fg]",
          `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=28:2,eq=brightness=-0.03:saturation=0.85[bgv]`,
          `[fg]scale=${Math.round(width * 0.92)}:-2:force_original_aspect_ratio=decrease,format=rgba,setsar=1[fgv]`,
          `[bgv][fgv]overlay=(W-w)/2:${Math.round(height * 0.16)}:format=auto,ass='${relativeCaptionPath}'`,
        ].join(";")
      : layout === "contain"
        ? [
            "split=2[bg][fg]",
            `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2,eq=brightness=-0.04:saturation=0.82[bgv]`,
            `[fg]scale=${Math.round(width * 0.94)}:${Math.round(height * 0.82)}:force_original_aspect_ratio=decrease,format=rgba,setsar=1[fgv]`,
            "[bgv][fgv]overlay=(W-w)/2:(H-h)/2:format=auto,ass='" + relativeCaptionPath + "'",
          ].join(";")
      : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},ass='${relativeCaptionPath}'`;
  execFileSync("ffmpeg", [
    "-y",
    "-i",
    capturePath,
    "-i",
    voiceoverPath,
    "-vf",
    vf,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    finalPath,
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function normalizeVisualClip({
  inputPath,
  outputPath,
  width,
  height,
  layout,
  cwd,
  durationSeconds,
  trimStartSeconds = 0,
}) {
  const vf = `${createLayoutFilter({ width, height, layout })},tpad=stop_mode=clone:stop_duration=${Math.ceil(durationSeconds)}`;

  const commandArgs = [
    "-y",
  ];
  if (trimStartSeconds > 0) {
    commandArgs.push("-ss", String(trimStartSeconds));
  }
  commandArgs.push(
    "-i",
    inputPath,
    "-t",
    String(durationSeconds),
    "-vf",
    vf,
    "-an",
    "-r",
    "25",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  );
  execFileSync("ffmpeg", commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function createVideoFromScreenshot({
  inputPath,
  outputPath,
  width,
  height,
  layout,
  cwd,
  durationSeconds,
}) {
  execFileSync("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-i",
    inputPath,
    "-t",
    String(durationSeconds),
    "-vf",
    createLayoutFilter({ width, height, layout }),
    "-an",
    "-r",
    "25",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function createLayoutFilter({ width, height, layout }) {
  if (layout === "desktop-in-vertical") {
    return [
      "split=2[bg][fg]",
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=28:2,eq=brightness=-0.03:saturation=0.85[bgv]`,
      `[fg]scale=${Math.round(width * 0.92)}:-2:force_original_aspect_ratio=decrease,format=rgba,setsar=1[fgv]`,
      `[bgv][fgv]overlay=(W-w)/2:${Math.round(height * 0.16)}:format=auto,setsar=1`,
    ].join(";");
  }
  if (layout === "contain") {
    return [
      "split=2[bg][fg]",
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2,eq=brightness=-0.04:saturation=0.82[bgv]`,
      `[fg]scale=${Math.round(width * 0.94)}:${Math.round(height * 0.82)}:force_original_aspect_ratio=decrease,format=rgba,setsar=1[fgv]`,
      "[bgv][fgv]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1",
    ].join(";");
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
}

function concatVideoClips(paths, outputPath, cwd) {
  const listPath = resolve(dirname(outputPath), "concat-list.txt");
  const content = paths
    .map((filePath) => `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  writeFileSync(listPath, `${content}\n`, "utf8");
  execFileSync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    outputPath,
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function composeVisualTrackWithAudio({
  visualTrackPath,
  voiceoverPath,
  captionsPath,
  finalPath,
  cwd,
}) {
  const relativeCaptionPath = `assets/${basename(captionsPath)}`;
  execFileSync("ffmpeg", [
    "-y",
    "-i",
    visualTrackPath,
    "-i",
    voiceoverPath,
    "-vf",
    `ass='${relativeCaptionPath}'`,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    finalPath,
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function escapePowerShellString(value) {
  return value.replace(/`/g, "``").replace(/"/g, '`"');
}

function collectChanges({ projectRoot, since, until }) {
  const range = `${since}..${until}`;
  const commits = runGit(projectRoot, [
    "log",
    "--no-merges",
    "--date=short",
    "--pretty=format:%h%x09%ad%x09%s",
    range,
  ]);
  const stats = runGit(projectRoot, ["diff", "--stat", range]);
  const files = runGit(projectRoot, ["diff", "--name-only", range])
    .split(/\r?\n/)
    .filter(Boolean);

  return {
    range,
    commits: commits ? commits.split(/\r?\n/).map(parseCommitLine) : [],
    stats,
    files,
  };
}

function parseCommitLine(line) {
  const [hash, date, ...subjectParts] = line.split("\t");
  return {
    hash,
    date,
    subject: subjectParts.join("\t"),
  };
}

function classifyFile(path) {
  if (path.includes("/api/") || path.includes("\\api\\")) return "API";
  if (path.includes("/components/") || path.includes("\\components\\")) return "UI";
  if (path.includes("/tests/") || path.includes("\\tests\\") || path.endsWith(".test.ts")) return "Tests";
  if (path.includes("/lib/db/") || path.includes("\\lib\\db\\")) return "Data";
  if (path.includes("/integrations/") || path.includes("\\integrations\\")) return "Integrations";
  if (path.includes("/workshops/") || path.includes("\\workshops\\")) return "Workshops";
  if (path.includes("/loops/") || path.includes("\\loops\\")) return "Automation";
  if (path.startsWith("docs/")) return "Docs";
  return "Core";
}

function summarizeChanges(changes) {
  const buckets = new Map();
  for (const file of changes.files) {
    const bucket = classifyFile(file);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  const topAreas = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const commitThemes = changes.commits.slice(0, 8).map((commit) => commit.subject);
  const benefitLines = topAreas.map(({ name }) => benefitForArea(name));

  return {
    title: makeReleaseTitle(topAreas),
    topAreas,
    commitThemes,
    benefits: [...new Set(benefitLines)].slice(0, 4),
  };
}

async function planReleaseVideo({ profile, changes, args }) {
  const heuristicSummary = summarizeChanges(changes);
  const heuristicPlan = createReleasePlan(heuristicSummary);

  if (args.planner === "heuristic") {
    return {
      planner: "heuristic",
      fallbackReason: null,
      summary: heuristicSummary,
      plan: heuristicPlan,
    };
  }

  try {
    const aiPlan =
      args.planner === "cc-sdk"
        ? await createCcSdkPlan({ profile, changes, heuristicSummary, args })
        : await createOpenAiCompatiblePlan({
            profile,
            changes,
            heuristicSummary,
            args,
          });
    return {
      planner: args.planner,
      fallbackReason: null,
      summary: aiPlan.summary,
      plan: aiPlan.plan,
    };
  } catch (error) {
    return {
      planner: "heuristic",
      requestedPlanner: args.planner,
      fallbackReason: error.message,
      summary: heuristicSummary,
      plan: heuristicPlan,
    };
  }
}

async function createOpenAiCompatiblePlan({
  profile,
  changes,
  heuristicSummary,
  args,
}) {
  if (!["bailian", "llm", "openai-compatible"].includes(args.planner)) {
    throw new Error(`Unknown planner: ${args.planner}`);
  }

  const config = getOpenAiCompatiblePlannerConfig();
  if (!config.apiKey) {
    throw new Error(
      "Bailian/OpenAI-compatible planner is not configured. Set AI_VIDEO_AGENT_LLM_API_KEY or LLM_API_KEY.",
    );
  }

  const prompt = buildCcPlannerPrompt({
    profile,
    changes,
    heuristicSummary,
    provider: args.provider,
  });
  const url = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            "You are a release marketing video planner. Return only valid JSON matching the requested schema. Do not include markdown fences.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.4,
      max_tokens: 4096,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Bailian/OpenAI-compatible planner request failed: HTTP ${response.status} ${body.slice(0, 500)}`,
    );
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Bailian/OpenAI-compatible planner returned an empty response");
  }

  const parsed = parseJsonObject(content);
  return normalizeCcPlan(parsed, heuristicSummary);
}

function getOpenAiCompatiblePlannerConfig() {
  return {
    apiKey: firstPresentEnv([
      "AI_VIDEO_AGENT_LLM_API_KEY",
      "INTERACTION_PROCESSOR_LLM_API_KEY",
      "WORKSHOP_PLANNER_LLM_API_KEY",
      "LLM_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "DASHSCOPE_API_KEY",
      "BAILIAN_API_KEY",
    ]),
    baseUrl:
      firstPresentEnv([
        "AI_VIDEO_AGENT_LLM_BASE_URL",
        "INTERACTION_PROCESSOR_LLM_BASE_URL",
        "WORKSHOP_PLANNER_LLM_BASE_URL",
        "LLM_BASE_URL",
        "DASHSCOPE_BASE_URL",
        "BAILIAN_BASE_URL",
      ]) ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model:
      firstPresentEnv([
        "AI_VIDEO_AGENT_LLM_MODEL",
        "INTERACTION_PROCESSOR_LLM_MODEL",
        "WORKSHOP_PLANNER_LLM_MODEL",
        "LLM_MODEL",
        "DASHSCOPE_MODEL",
        "BAILIAN_MODEL",
      ]) ?? "qwen-plus",
  };
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  if (trimmed.endsWith("/compatible-mode")) return `${trimmed}/v1`;
  return trimmed;
}

async function createCcSdkPlan({ profile, changes, heuristicSummary, args }) {
  const apiKey = firstPresentEnv([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "LLM_API_KEY",
  ]);
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/LLM_API_KEY is not configured");
  }

  let sdk;
  try {
    sdk = await import("@anthropic-ai/claude-agent-sdk");
  } catch (error) {
    throw new Error(`@anthropic-ai/claude-agent-sdk is not installed or resolvable: ${error.message}`);
  }

  const prompt = buildCcPlannerPrompt({ profile, changes, heuristicSummary, provider: args.provider });
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL:
      firstPresentEnv(["ANTHROPIC_BASE_URL", "LLM_BASE_URL"]) ?? "",
    ANTHROPIC_MODEL:
      firstPresentEnv(["ANTHROPIC_MODEL", "LLM_MODEL"]) ?? "",
  };

  let fullResponse = "";
  for await (const message of sdk.query({
    prompt,
    options: {
      cwd: args.projectRoot,
      env,
      maxTurns: 1,
      settingSources: [],
      allowedTools: [],
      systemPrompt:
        "You are a release marketing video planner. Return only valid JSON matching the requested schema. Do not include markdown fences.",
    },
  })) {
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if (typeof block.text === "string") {
          fullResponse += block.text;
        }
      }
    }
  }

  const parsed = parseJsonObject(fullResponse);
  return normalizeCcPlan(parsed, heuristicSummary);
}

function firstPresentEnv(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value && !isPlaceholderEnvValue(value)) return value;
  }
  return undefined;
}

function isPlaceholderEnvValue(value) {
  return /^(?:\*+|x+|your[-_ ].*|replace[-_ ].*)$/i.test(value.trim());
}

function buildCcPlannerPrompt({ profile, changes, heuristicSummary, provider }) {
  const commitLines = changes.commits
    .slice(0, 20)
    .map((commit) => `- ${commit.hash} ${commit.date}: ${commit.subject}`)
    .join("\n");
  const fileLines = changes.files.slice(0, 220).map((file) => `- ${file}`).join("\n");
  const stat = truncateLines(changes.stats || "No diff stat available.", 120);

  return `Create a project-specific release promotion video plan from these real Git changes.

Rules:
- Base claims only on the provided project profile, commits, files, and diff stat.
- Translate technical changes into user benefits.
- Prefer real product screen recordings. Use AI video generation only for one or two polish shots.
- Keep the target video between 20 and 45 seconds.
- Primary aspect ratio is 9:16.
- Selected video provider is ${provider}.
- Return only JSON with this exact top-level shape:
{
  "summary": {
    "title": "string",
    "topAreas": [{"name": "string", "count": 1}],
    "commitThemes": ["string"],
    "benefits": ["string"]
  },
  "plan": {
    "script": "markdown string",
    "storyboard": {
      "version": 1,
      "targetLengthSeconds": 30,
      "primaryAspectRatio": "9:16",
      "scenes": [
        {
          "id": "scene-01-hook",
          "durationSeconds": 4,
          "assetType": "screen-recording",
          "visual": "string",
          "voiceover": "string",
          "caption": "string",
          "videoModel": null
        }
      ]
    },
    "socialPosts": "markdown string"
  }
}

Project profile:
${profile}

Heuristic starting point:
${JSON.stringify(heuristicSummary, null, 2)}

Git range: ${changes.range}

Commits:
${commitLines || "- No commits found."}

Changed files sample:
${fileLines || "- No changed files found."}

Diff stat sample:
\`\`\`text
${stat}
\`\`\`

Language requirement:
- The primary audience is in China.
- Write script, voiceover, captions, benefits, and social posts in Simplified Chinese by default.
- Keep product names such as Zhiyu in English only when needed; otherwise use natural Chinese copy.`;
}

function parseJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  throw new Error("Claude Agent SDK did not return parseable JSON");
}

function normalizeCcPlan(parsed, heuristicSummary) {
  const summary = {
    title: stringOr(parsed?.summary?.title, heuristicSummary.title),
    topAreas: Array.isArray(parsed?.summary?.topAreas)
      ? parsed.summary.topAreas.slice(0, 6).map((area) => ({
          name: stringOr(area?.name, "Core"),
          count: Number.isFinite(Number(area?.count)) ? Number(area.count) : 1,
        }))
      : heuristicSummary.topAreas,
    commitThemes: stringArrayOr(parsed?.summary?.commitThemes, heuristicSummary.commitThemes).slice(0, 8),
    benefits: stringArrayOr(parsed?.summary?.benefits, heuristicSummary.benefits).slice(0, 5),
  };

  const fallbackPlan = createReleasePlan(summary);
  const storyboard = parsed?.plan?.storyboard && typeof parsed.plan.storyboard === "object"
    ? {
        version: 1,
        targetLengthSeconds:
          Number.isFinite(Number(parsed.plan.storyboard.targetLengthSeconds))
            ? Number(parsed.plan.storyboard.targetLengthSeconds)
            : fallbackPlan.storyboard.targetLengthSeconds,
        primaryAspectRatio: stringOr(parsed.plan.storyboard.primaryAspectRatio, "9:16"),
        scenes: normalizeScenes(parsed.plan.storyboard.scenes, fallbackPlan.storyboard.scenes),
      }
    : fallbackPlan.storyboard;

  return {
    summary,
    plan: {
      script: stringOr(parsed?.plan?.script, fallbackPlan.script),
      storyboard,
      socialPosts: stringOr(parsed?.plan?.socialPosts, fallbackPlan.socialPosts),
    },
  };
}

function normalizeScenes(scenes, fallbackScenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) return fallbackScenes;
  return scenes.slice(0, 8).map((scene, index) => ({
    id: stringOr(scene?.id, `scene-${String(index + 1).padStart(2, "0")}`),
    durationSeconds: Number.isFinite(Number(scene?.durationSeconds))
      ? Number(scene.durationSeconds)
      : 5,
    assetType: stringOr(scene?.assetType, "screen-recording"),
    visual: stringOr(scene?.visual, "Show the relevant product screen."),
    voiceover: stringOr(scene?.voiceover, ""),
    caption: stringOr(scene?.caption, ""),
    videoModel: typeof scene?.videoModel === "string" ? scene.videoModel : null,
  }));
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArrayOr(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((item) => typeof item === "string" && item.trim());
  return strings.length ? strings : fallback;
}

function makeReleaseTitle(topAreas) {
  const names = topAreas.map((area) => area.name);
  if (names.includes("Workshops") && names.includes("Automation")) {
    return "Zhiyu workshop automation gets more capable";
  }
  if (names.includes("Integrations")) {
    return "Zhiyu connects more of your work";
  }
  if (names.includes("UI")) {
    return "Zhiyu gets a clearer daily workspace";
  }
  return "Zhiyu release update";
}

function benefitForArea(area) {
  const benefits = {
    API: "More reliable product behavior behind the scenes.",
    UI: "A smoother workspace that is easier to scan and use.",
    Tests: "More confidence that important workflows keep working.",
    Data: "Stronger persistence for memories, tasks, and workspace state.",
    Integrations: "More connected tools inside the same AI workspace.",
    Workshops: "Smarter workshop flows that can carry more context forward.",
    Automation: "More repeatable AI-driven routines with less manual follow-up.",
    Docs: "Clearer project knowledge for users and future contributors.",
    Core: "Foundational improvements that make the project easier to extend.",
  };
  return benefits[area] ?? benefits.Core;
}

function createReleasePlan(summary) {
  return {
    script: createScript(summary),
    storyboard: createStoryboard(summary),
    socialPosts: createSocialPosts(summary),
  };
}

function createBrief(profile, changes, summary) {
  const diffStat = truncateLines(changes.stats || "No diff stat available.", 180);

  return `# Release Video Brief

## Source

- Project root: \`${changes.projectRoot}\`
- Git range: \`${changes.range}\`
- Commits reviewed: ${changes.commits.length}
- Files changed: ${changes.files.length}

## Project Memory

${profile.trim()}

## Release Angle

${summary.title}

## User Benefits

${summary.benefits.map((item) => `- ${item}`).join("\n")}

## Technical Evidence

### Main Areas

${summary.topAreas.map((area) => `- ${area.name}: ${area.count} changed files`).join("\n")}

### Commit Themes

${summary.commitThemes.map((item) => `- ${item}`).join("\n")}

## Diff Stat

\`\`\`text
${diffStat}
\`\`\`
`;
}

function truncateLines(text, maxLines) {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return text;
  }

  const remaining = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join("\n")}\n... ${remaining} more diff-stat lines omitted for readability.`;
}

function createScript(summary) {
  const benefits = summary.benefits;
  const first = benefits[0] ?? "The workspace is more useful in everyday work.";
  const second = benefits[1] ?? "The system is easier to extend and keep reliable.";
  const third = benefits[2] ?? "The update keeps more context close to the user.";

  return `# Video Script

## Format

- Length: 30 seconds
- Ratio: 9:16 first, adaptable to 16:9
- Style: real product recording plus light AI motion shots

## Voiceover

This Zhiyu update is about making the AI workspace feel more continuous.

First, ${first.toLowerCase()}

Second, ${second.toLowerCase()}

And under the surface, ${third.toLowerCase()}

If you use Zhiyu as your personal AI command center, this release makes the workspace a little more capable, and a little easier to trust.

## On-screen Captions

1. Zhiyu release update
2. ${first}
3. ${second}
4. ${third}
5. Your personal AI workspace, improving every release
`;
}

function createStoryboard(summary) {
  const benefits = summary.benefits.slice(0, 3);
  const scenes = [
    {
      id: "scene-01-hook",
      durationSeconds: 4,
      assetType: "screen-recording",
      visual: "Fast product dashboard opening shot with cursor moving toward the updated workspace.",
      voiceover: "This Zhiyu update is about making the AI workspace feel more continuous.",
      caption: "Zhiyu release update",
      videoModel: null,
    },
    ...benefits.map((benefit, index) => ({
      id: `scene-0${index + 2}-benefit`,
      durationSeconds: 6,
      assetType: "screen-recording-plus-ai-motion",
      visual: `Show the relevant product area, then add a subtle AI-generated motion background for polish. Benefit: ${benefit}`,
      voiceover: benefit,
      caption: benefit,
      videoModel: index === 0 ? "fal:hailuo-02-standard" : null,
    })),
    {
      id: "scene-05-close",
      durationSeconds: 5,
      assetType: "screen-recording",
      visual: "Return to the product home view and show the release name.",
      voiceover: "Your personal AI workspace, improving every release.",
      caption: "Improving every release",
      videoModel: null,
    },
  ];

  return {
    version: 1,
    targetLengthSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
    primaryAspectRatio: "9:16",
    scenes,
  };
}

function createSocialPosts(summary) {
  const bullets = summary.benefits.map((item) => `- ${item}`).join("\n");
  return `# Social Posts

## Bilibili / YouTube

Zhiyu 新版本来了。这次更新重点不是堆功能，而是让个人 AI 工作区更连续、更可靠。

${bullets}

完整演示视频里可以看到这次更新如何改变日常使用体验。

## Douyin / Shorts

Zhiyu 更新：你的个人 AI 工作区又进化了一点。

${summary.benefits.slice(0, 2).join(" ")}

## Release Note Teaser

${summary.title}
`;
}

function createProviderPlan(storyboard, selectedProvider) {
  const provider = providerCatalog[selectedProvider] ?? providerCatalog["fal:hailuo-02-standard"];
  const aiScenes = storyboard.scenes.filter((scene) => scene.videoModel);
  const totalSeconds = aiScenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  const estimatedCostUsd = Number((totalSeconds * provider.priceUsd).toFixed(4));

  return {
    selectedProvider,
    provider,
    strategy: "Use real screen recordings for product truth. Spend video API budget only on the hook or polish shots.",
    aiGeneratedSeconds: totalSeconds,
    estimatedCostUsd,
    scenes: aiScenes.map((scene) => ({
      id: scene.id,
      durationSeconds: scene.durationSeconds,
      provider: selectedProvider,
      estimatedCostUsd: Number((scene.durationSeconds * provider.priceUsd).toFixed(4)),
    })),
  };
}

function writeOutput(args, changes, plannerResult, profile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = resolve(args.outputRoot, stamp);
  mkdirSync(outputDir, { recursive: true });

  const enrichedChanges = { ...changes, projectRoot: args.projectRoot };
  const { summary, plan } = plannerResult;
  const storyboard = plan.storyboard;
  const files = {
    "brief.md": createBrief(profile, enrichedChanges, summary),
    "script.md": plan.script,
    "storyboard.json": `${JSON.stringify(storyboard, null, 2)}\n`,
    "social-posts.md": plan.socialPosts,
    "provider-plan.json": `${JSON.stringify(createProviderPlan(storyboard, args.provider), null, 2)}\n`,
    "planner-metadata.json": `${JSON.stringify(
      {
        planner: plannerResult.planner,
        requestedPlanner: plannerResult.requestedPlanner ?? plannerResult.planner,
        fallbackReason: plannerResult.fallbackReason ?? null,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  };

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(resolve(outputDir, name), content, "utf8");
  }

  return outputDir;
}

function printHelp() {
  console.log(`AI Release Video Agent

Usage:
  node src/index.mjs generate [options]
  node src/index.mjs render [options]

Options:
  --project-root <path>  Git project to inspect
  --since <ref>          Start ref, default HEAD~5
  --until <ref>          End ref, default HEAD
  --profile <path>       Project memory markdown file
  --provider <id>        Provider id for cost planning
  --planner <mode>       heuristic | bailian | llm | openai-compatible | cc-sdk
  --env-file <path>      Env file to load before planning
  --url <url>            Product page to record, default http://127.0.0.1:3515/workshop
  --width <px>           Output video width, default 1080
  --height <px>          Output video height, default 1920
  --capture-width <px>   Browser capture width, default 1440
  --capture-height <px>  Browser capture height, default 900
  --layout <mode>        desktop-in-vertical | crop, default desktop-in-vertical
  --subtitle-language    Subtitle/voiceover language for render, default zh-CN
  --tts-provider <name>  edge | sapi, default edge
  --tts-voice <name>     TTS voice, default zh-CN-XiaoxiaoNeural
  --use-ai-video         Enable hybrid rendering with AI-generated concept shots
  --video-provider <id>  mock | wan, default mock
  --video-model <name>   Video model for provider=wan, default wan2.7-t2v-2026-06-12
  --video-endpoint <url> Async video synthesis endpoint for provider=wan
  --video-workspace-id <id> Workspace id used to build the Wan business-space endpoint
  --video-region <id>    cn-beijing | ap-southeast-1 | eu-central-1, default cn-beijing
  --video-resolution <r>  480P | 720P | 1080P, default 720P
  --video-ratio <ratio>  16:9 | 9:16 | 1:1, defaults from output size
  --video-watermark      Keep provider watermark for Wan output
  --reuse-ai-video       Reuse existing ai-shot.mp4 files instead of calling the video provider again
  --max-ai-shots <n>     Maximum AI-generated shots in one render, default 2
  --ai-fallback <mode>   mock | none, default mock
  --output-root <path>   Output directory
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.command || args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }
  if (args.command === "render") {
    args.loadedEnvFiles = loadProjectEnv(args);
    const result = await renderVideo(args);
    console.log(`Rendered release video: ${result.finalPath}`);
    console.log(`Assets: ${result.assetsDir}`);
    if (args.loadedEnvFiles.length > 0) {
      console.log(`Loaded env files: ${args.loadedEnvFiles.join(", ")}`);
    }
    return;
  }
  if (args.command !== "generate") {
    throw new Error(`Unknown command: ${args.command}`);
  }

  const loadedEnvFiles = loadProjectEnv(args);
  const profile = readFileSync(args.profile, "utf8");
  const changes = collectChanges(args);
  const plannerResult = await planReleaseVideo({ profile, changes, args });
  const outputDir = writeOutput(args, changes, plannerResult, profile);

  console.log(`Generated release video plan: ${outputDir}`);
  if (loadedEnvFiles.length > 0) {
    console.log(`Loaded env files: ${loadedEnvFiles.join(", ")}`);
  }
  console.log(`Planner: ${plannerResult.planner}`);
  if (plannerResult.fallbackReason) {
    console.log(`Planner fallback reason: ${plannerResult.fallbackReason}`);
  }
  console.log(`Release angle: ${plannerResult.summary.title}`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
