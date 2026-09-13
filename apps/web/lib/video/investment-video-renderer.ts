import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRuntimeDirectory, readRuntimeText, runtimeFileExists, writeRuntimeText } from "./runtime-file-io";
import { dirname, join, resolve } from "node:path";
import { getAppDir } from "@/lib/env/config/constants";

export interface InvestmentVideoSceneInput {
  shot?: {
    mode: "generated" | "title" | "graphic";
    rationale: string;
    prompt?: string;
    motion?: "static" | "push-in" | "pull-out" | "pan-left";
    transition?: "cut" | "fade";
    background?: string;
    foreground?: string;
    accent?: string;
  };
  onScreen?: {
    kind: "process" | "comparison" | "takeaway";
    title: string;
    items: string[];
    left?: { title: string; items: string[] };
    right?: { title: string; items: string[] };
    source?: string;
  };
  id?: string;
  durationSeconds?: number;
  assetType?: "mock-visual" | "screen-recording" | "ai-background";
  visual?: string;
  voiceover: string;
  caption: string;
}

export interface InvestmentVideoRenderInput {
  title: string;
  description?: string;
  scenes: InvestmentVideoSceneInput[];
  riskDisclosure: string;
  topics?: string[];
  durationSeconds?: number;
  width?: number;
  height?: number;
  ttsVoice?: string;
  useScreenRecording?: boolean;
  productUrl?: string;
  userId?: string;
  workshopId?: string;
  runId?: string | null;
}

export interface InvestmentVideoRenderResult {
  ok: boolean;
  provider: "local-ffmpeg-cut";
  localPath: string | null;
  planDir: string;
  assetsDir: string;
  manifestPath: string;
  storyboardPath: string;
  scriptPath: string;
  title: string;
  durationSeconds: number;
  renderMode: "remotion-editorial" | "screen-recording";
  warnings: string[];
  error?: string;
  stdout?: string;
  stderr?: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_CHARS = 250_000;

function videoToolPath() {
  let current = process.cwd();
  for (let index = 0; index < 6; index += 1) {
    const candidate = join(
      current,
      "tools",
      "ai-release-video-agent",
      "src",
      "index.mjs",
    );
    if (runtimeFileExists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(
    process.cwd(),
    "tools",
    "ai-release-video-agent",
    "src",
    "index.mjs",
  );
}

function defaultOutputDir(input: InvestmentVideoRenderInput) {
  const scope = input.workshopId
    ? join("workshops", input.workshopId, input.runId ?? "manual")
    : join("video", input.userId ?? "default");
  return join(getAppDir(), "generated-videos", scope);
}

function safeId(value: string, fallback: string) {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return safe || fallback;
}

function normalizedScenes(input: InvestmentVideoRenderInput) {
  const sourceScenes = input.scenes.length
    ? input.scenes
    : [
        {
          voiceover: input.description || input.title,
          caption: input.title,
          visual: "投研复盘重点摘要",
        },
      ];
  return sourceScenes.slice(0, 12).map((scene, index) => ({
    id: safeId(scene.id ?? `scene-${index + 1}`, `scene-${index + 1}`),
    durationSeconds: Math.max(3, Math.min(18, scene.durationSeconds ?? 8)),
    assetType:
      scene.assetType === "screen-recording"
        ? "screen-recording"
        : "screen-recording-plus-ai-motion",
    visual: scene.visual || scene.caption || scene.voiceover,
    onScreen: scene.onScreen,
    shot: scene.shot,
    voiceover: scene.voiceover.trim(),
    caption: scene.caption.trim().slice(0, 36),
    videoModel: scene.assetType === "ai-background" ? "mock-local" : null,
  }));
}

function buildScript(input: InvestmentVideoRenderInput, scenes: ReturnType<typeof normalizedScenes>) {
  const voiceover = scenes.map((scene) => scene.voiceover).join("\n\n");
  const captions = scenes
    .map((scene, index) => `${index + 1}. ${scene.caption}`)
    .join("\n");
  const topics = input.topics?.length ? input.topics.join(" / ") : "投研复盘";
  return [
    `# ${input.title}`,
    "",
    "## Voiceover",
    "",
    voiceover,
    "",
    "## On-screen Captions",
    "",
    captions,
    "",
    "## Risk Disclosure",
    "",
    input.riskDisclosure,
    "",
    "## Topics",
    "",
    topics,
    "",
  ].join("\n");
}

function sumDuration(scenes: ReturnType<typeof normalizedScenes>) {
  return scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
}

function runRenderer(args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [videoToolPath(), ...args], {
      cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
        PYTHONUTF8: process.env.PYTHONUTF8 || "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Video renderer timed out after ${DEFAULT_TIMEOUT_MS}ms.`));
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_CHARS) child.kill();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Video renderer exited with code ${String(code)}.`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

export async function renderInvestmentResearchVideo(
  input: InvestmentVideoRenderInput,
): Promise<InvestmentVideoRenderResult> {
  const warnings: string[] = [];
  const scenes = normalizedScenes(input);
  const targetDuration = Math.max(
    20,
    Math.min(180, input.durationSeconds ?? sumDuration(scenes)),
  );
  const planDir = resolve(defaultOutputDir(input), `local-cut-${randomUUID()}`);
  const assetsDir = join(planDir, "assets");
  const storyboardPath = join(planDir, "storyboard.json");
  const scriptPath = join(planDir, "script.md");
  const manifestPath = join(planDir, "manifest.json");
  const renderMode = input.useScreenRecording ? "screen-recording" : "remotion-editorial";

  try {
    await createRuntimeDirectory(assetsDir);
    const storyboard = {
      version: 1,
      targetLengthSeconds: targetDuration,
      primaryAspectRatio: "9:16",
      scenes,
    };
    const manifest = {
      title: input.title,
      description: input.description ?? "",
      riskDisclosure: input.riskDisclosure,
      topics: input.topics ?? [],
      renderMode,
      generatedAt: new Date().toISOString(),
      outputPolicy: {
        textRendering: "local_subtitle_and_drawtext_only",
        aiVideoText: "forbidden",
      },
    };
    await writeRuntimeText(storyboardPath, `${JSON.stringify(storyboard, null, 2)}\n`);
    await writeRuntimeText(scriptPath, buildScript(input, scenes));
    await writeRuntimeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const rendererArgs = [
      "render",
      "--plan-dir",
      planDir,
      "--duration",
      String(targetDuration),
      "--width",
      String(input.width ?? 720),
      "--height",
      String(input.height ?? 1280),
      "--tts-provider",
      "edge",
      "--tts-voice",
      input.ttsVoice || "zh-CN-XiaoxiaoNeural",
    ];
    if (input.useScreenRecording) {
      rendererArgs.push("--url", input.productUrl || "http://127.0.0.1:3515/quant");
    } else {
      rendererArgs.push("--use-ai-video", "--video-provider", scenes.some(scene => scene.shot?.mode === "generated") ? "wan" : "mock", "--ai-fallback", "error", "--max-ai-shots", "12");
    }

    const { stdout, stderr } = await runRenderer(rendererArgs, planDir);
    const localPath = join(assetsDir, "final.mp4");
    if (!runtimeFileExists(localPath)) {
      throw new Error("Renderer completed but final.mp4 was not created.");
    }
    if (stderr.includes("falling back to Windows SAPI")) {
      warnings.push("Edge TTS unavailable; Windows SAPI voice was used.");
    }
    let actualDuration = targetDuration;
    try {
      const renderMetadata = JSON.parse(
        await readRuntimeText(join(assetsDir, "render-metadata.json")),
      ) as { durationSeconds?: unknown; warnings?: string[] };
      if (Array.isArray(renderMetadata.warnings)) warnings.push(...renderMetadata.warnings);
      if (
        typeof renderMetadata.durationSeconds === "number" &&
        Number.isFinite(renderMetadata.durationSeconds)
      ) {
        actualDuration = renderMetadata.durationSeconds;
      }
    } catch {
      warnings.push("Render metadata was unavailable; reported duration is planned duration.");
    }
    return {
      ok: true,
      provider: "local-ffmpeg-cut",
      localPath,
      planDir,
      assetsDir,
      manifestPath,
      storyboardPath,
      scriptPath,
      title: input.title,
      durationSeconds: actualDuration,
      renderMode,
      warnings,
      stdout: stdout.trim() || undefined,
      stderr: stderr.trim() || undefined,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "local-ffmpeg-cut",
      localPath: null,
      planDir,
      assetsDir,
      manifestPath,
      storyboardPath,
      scriptPath,
      title: input.title,
      durationSeconds: targetDuration,
      renderMode,
      warnings,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
