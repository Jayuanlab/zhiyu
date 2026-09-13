#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const planDir = resolve(process.argv[2] || "");
const assetsDir = resolve(planDir, "assets");
const metadataPath = resolve(assetsDir, "render-metadata.json");
const storyboardPath = resolve(planDir, "storyboard.json");
const shotManifestPath = resolve(assetsDir, "shot-manifest.json");
const captionsPath = resolve(assetsDir, "captions.ass");
const failures = [];
const editPlanPath = resolve(planDir, 'edit-plan.json');
if (existsSync(editPlanPath)) {
  const plan = JSON.parse(readFileSync(editPlanPath, 'utf8'));
  if (plan.renderer === 'remotion') {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const duration = Number(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',metadata.finalPath], {encoding:'utf8',windowsHide:true}).trim());
    if (Math.abs(duration - plan.frames / plan.fps) > .2) failures.push('Final duration does not match timeline');
    if (metadata.voiceoverDurationSeconds > duration + .2) failures.push('Narration truncated');
    for (const shot of plan.shots) {
      if (shot.captionTiming !== 'tts-boundary') failures.push('Missing TTS timing');
      if (/对比图[:：]|底部显示|中央大字|用红色箭头/.test(JSON.stringify(shot.display))) failures.push('Production directions leaked');
    }
    if (!plan.captions.length || plan.captions.some(c => c.end <= c.start || c.start < 0 || c.end > duration + .2)) failures.push('Invalid caption timeline');
    console.log(failures.length ? `FAIL: ${failures.join('; ')}` : 'PASS: editorial contract, TTS timestamps, timeline and audio coverage. Visual review still required.');
    process.exit(failures.length ? 1 : 0);
  }
}

for (const filePath of [metadataPath, storyboardPath, shotManifestPath, captionsPath]) {
  if (!existsSync(filePath)) failures.push(`missing artifact: ${filePath}`);
}

if (failures.length === 0) {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const storyboard = JSON.parse(readFileSync(storyboardPath, "utf8"));
  const shots = JSON.parse(readFileSync(shotManifestPath, "utf8")).shots || [];
  const captions = readFileSync(captionsPath, "utf8");
  const finalPath = metadata.finalPath;
  if (!finalPath || !existsSync(finalPath)) failures.push("final video is missing");

  const videoDuration = finalPath && existsSync(finalPath)
    ? Number(execFileSync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", finalPath,
      ], { encoding: "utf8" }).trim())
    : 0;
  if (metadata.voiceoverDurationSeconds > videoDuration + 0.75) {
    failures.push(
      `narration is truncated: audio=${metadata.voiceoverDurationSeconds.toFixed(2)}s video=${videoDuration.toFixed(2)}s`,
    );
  }

  const sceneCount = Array.isArray(storyboard.scenes) ? storyboard.scenes.length : 0;
  const dialogueCount = (captions.match(/^Dialogue:/gm) || []).length;
  const longNarration = (storyboard.scenes || []).some(
    (scene) => String(scene.voiceover || "").replace(/\s+/g, "").length > 40,
  );
  if (longNarration && dialogueCount <= sceneCount) {
    failures.push(`captions are not segmented: dialogues=${dialogueCount} scenes=${sceneCount}`);
  }

  for (const shot of shots) {
    if (shot.provider !== "mock") continue;
    const cardPath = resolve(dirname(shot.path), "knowledge-card.png");
    if (!existsSync(cardPath)) failures.push(`mock shot has no designed card: ${shot.id}`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("PASS: narration coverage, caption segmentation, and designed local shots verified");
}
