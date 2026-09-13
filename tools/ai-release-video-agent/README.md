# AI Release Video Agent

## Editorial rendering (2026-09-12)

The workshop default local route now renders a Remotion timeline, not placeholder
FFmpeg cards. The existing CLI `--use-ai-video --video-provider mock` remains a
compatibility alias; metadata identifies the actual renderer as
`remotion-editorial`. Three structured `onScreen.kind` layouts are supported:
`process`, `comparison`, and `takeaway`. See `fixtures/editorial-smoke/storyboard.json`.
`visual` is private direction and never viewer text. Legacy scenes use narration
summaries with an explicit adaptation warning; they do not invent diagrams.

Each narration segment is synthesized separately. Edge TTS subtitle timestamps
drive captions, scene lengths follow measured audio, and nodes enter at matched
sentence boundaries (or sentence order when text differs). This is sentence-level
timing, not validated word-level alignment. Missing TTS timestamps stop the draft
render instead of silently reverting to estimated timing.

Install Node dependencies with `npm ci --prefix tools/ai-release-video-agent`
from the repository root. Remotion packages are pinned at 4.0.524. This integration
is for local video creation; Remotion's license is not MIT. The exact installed
license is in `node_modules/remotion/LICENSE.md`; check eligibility before
redistributing or operating this as a commercial service.

Run the real workshop rendering service smoke check from `apps/web`:

```powershell
node --import tsx scripts/verify-editorial-video.mts
```

This creates a new version under the user's generated-videos directory, writes a
result pointer in the fixture directory, and never creates or publishes a platform
draft. `quality-report.json` records technical checks and still requires visual
review. Previously rendered final videos are not overwritten.

Demo agent for turning project updates into repeatable release-promotion video plans.

The first version is intentionally offline and cheap: it reads Git history, translates changes into user-facing benefits, and writes the assets a renderer would need. Real video APIs can be added behind the provider adapter after the story pipeline is stable.

## Why This Lives Under `tools/`

This is a companion project for Zhiyu, not part of the web app runtime yet. Keeping it under `tools/ai-release-video-agent` lets us iterate without coupling it to the main application or touching existing workspace changes. Once the workflow is useful, it can be exposed inside `apps/web`.

## Run

```powershell
cd D:\zhiyu\tools\ai-release-video-agent
node src/index.mjs generate --project-root ..\.. --since HEAD~5
```

Or use the shortcut:

```powershell
npm run demo
```

## Use Bailian / DashScope

The default planner uses the same OpenAI-compatible Bailian/DashScope configuration style as OpenZhiYu. Set `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`, then run:

```powershell
$env:LLM_API_KEY="your-bailian-key"
$env:LLM_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:LLM_MODEL="qwen-plus"
node src/index.mjs generate --project-root ..\.. --since HEAD~5 --planner bailian
```

You can also use dedicated variables for this tool:

```dotenv
AI_VIDEO_AGENT_LLM_API_KEY=your-bailian-key
AI_VIDEO_AGENT_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_VIDEO_AGENT_LLM_MODEL=qwen-plus
```

Fallback order:

```text
AI_VIDEO_AGENT_LLM_* -> WORKSHOP_PLANNER_LLM_* -> LLM_* -> DASHSCOPE_API_KEY / BAILIAN_API_KEY
```

The tool also reads `INTERACTION_PROCESSOR_LLM_*`, matching Zhiyu's DashScope-backed interaction pipeline.

`--planner bailian` is optional because Bailian is the default. If no key is configured, the demo falls back to the offline planner and marks the planner mode in `planner-metadata.json`.

## Use Claude Agent SDK

Claude Agent SDK is still available for Anthropic-compatible agent runs:

```dotenv
ANTHROPIC_API_KEY=your-key
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-6
```

```powershell
node src/index.mjs generate --project-root ..\.. --since HEAD~5 --planner cc-sdk
```

## Output

Each run creates a folder under `outputs/`, for example:

```text
outputs/2026-07-23T10-20-30-000Z/
  brief.md
  script.md
  storyboard.json
  social-posts.md
  provider-plan.json
  planner-metadata.json
```

## Render A Real Product Video

Create the project-local Python environment once so Chinese narration uses Edge
neural TTS instead of the lower-quality Windows SAPI fallback:

```powershell
py -3.12 -m venv .venv312
uv pip install --python .venv312\Scripts\python.exe -r requirements.txt
```

After generating a plan, render a first local video cut from a live Zhiyu page:

```powershell
cd D:\zhiyu\tools\ai-release-video-agent
node src/index.mjs render
```

## Render A Hybrid AI Video Cut

The renderer can now mix real product recordings with AI-generated concept shots:

```powershell
node src/index.mjs render --use-ai-video --video-provider mock
```

This produces:

```text
assets/
  shots/
    01-scene-.../ai-shot-mock.mp4
    02-scene-.../screen-shot.mp4
  visual-track.mp4
  shot-manifest.json
  final.mp4
```

The `mock` provider is intentionally local and cheap. It creates designed,
topic-specific knowledge cards in Playwright, adds restrained camera motion with
FFmpeg, and keeps all readable text in deterministic local layers. Real video
providers can replace selected shots without changing the rest of the render
chain.

Validate a finished render with:

```powershell
node scripts/validate-render.mjs <plan-directory>
```

The validator rejects truncated narration, unsegmented long subtitles, missing
final media, and legacy placeholder mock shots.

Useful options:

```powershell
node src/index.mjs render `
  --use-ai-video `
  --video-provider mock `
  --max-ai-shots 2 `
  --url http://127.0.0.1:3515/workshop
```

## Use Bailian / Wan Video

To use Tongyi Wanxiang through Bailian/DashScope, configure the API key. The renderer reads the same project env files as the planner (`apps/web/.env`, then `.env`) and can use `INTERACTION_PROCESSOR_LLM_API_KEY` as the Bailian key.

```dotenv
AI_VIDEO_AGENT_VIDEO_API_KEY=your-bailian-or-dashscope-key
```

For the newer business-space endpoint, add your workspace id. Otherwise Beijing defaults to the legacy public DashScope endpoint:

```dotenv
AI_VIDEO_AGENT_VIDEO_WORKSPACE_ID=your-workspace-id
AI_VIDEO_AGENT_VIDEO_REGION=cn-beijing
```

You can also provide the endpoint directly:

```dotenv
AI_VIDEO_AGENT_VIDEO_ENDPOINT=https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis
```

Then run:

```powershell
node src/index.mjs render `
  --use-ai-video `
  --video-provider wan `
  --video-model wan2.7-t2v-2026-06-12 `
  --width 1920 `
  --height 1080 `
  --layout contain
```

Fallback behavior:

- If Wan succeeds, the AI concept shots come from the remote video model.
- If Wan fails and `--ai-fallback mock` is active, the renderer keeps going with local mock shots.
- Use `--ai-fallback none` when you want provider failures to stop the render.
- Wan HTTP video generation is async. The renderer creates a task, polls `/api/v1/tasks/{task_id}`, then downloads the returned MP4. Debug files are written beside the shot as `wan-request.json`, `wan-create-response.json`, and `wan-task-result.json`.

Optional:

```powershell
node src/index.mjs render --plan-dir outputs\2026-07-22T17-48-05-577Z --url http://127.0.0.1:3515/workshop --duration 30
```

The render step creates:

```text
assets/
  capture.webm
  voiceover.mp3
  captions.srt
  captions.ass
  final.mp4
```

This first renderer uses:

- Playwright for real browser recording. By default it records a desktop viewport, then places it into a vertical video so the app is not squeezed into a tall narrow layout.
- Edge neural TTS for Chinese voiceover by default, with Windows SAPI as a fallback.
- FFmpeg for subtitle/audio/video composition.

Start the Zhiyu dev server first if `http://127.0.0.1:3515/workshop` is not already running.

For Chinese audiences, render defaults to:

```text
--subtitle-language zh-CN
--tts-provider edge
--tts-voice zh-CN-XiaoxiaoNeural
```

Alternative voices can be passed with `--tts-voice`, for example `zh-CN-YunxiNeural`.

## Next API Layer

Recommended provider order for a personal developer:

1. `fal:hailuo-02-standard` for low-cost product screenshot animation.
2. `fal:wan-2.5` for cheap draft generation.
3. `fal:kling-2.5-turbo-pro` for higher quality shots.
4. `runway:gen4-turbo` or `veo` only for important hero shots.

The demo writes a `provider-plan.json` with estimated costs so the renderer can later decide which scenes should call an external video model.
