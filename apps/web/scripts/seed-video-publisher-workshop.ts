import Module from "node:module";
import type { Workshop, WorkshopSource } from "@/lib/db/schema";

type ModuleLoad = (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) => unknown;

const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only" || request.includes("server-only")) {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const [
  { closeDb },
  {
    createLoop,
    getLoopState,
    listLoopsForWorkshop,
    loopSpecToCreateLoopInput,
    parseLoopSpec,
    updateLoop,
    upsertLoopState,
  },
  {
    addWorkshopDirective,
    addWorkshopMemory,
    addWorkshopSource,
    appendWorkshopEvent,
    createWorkshop,
    listActiveDirectives,
    listWorkshopMemories,
    listWorkshops,
    listWorkshopSources,
    updateWorkshop,
  },
] = await Promise.all([
  import("@/lib/db/adapters"),
  import("@/lib/loops"),
  import("@/lib/workshops/service"),
]);

const USER_ID =
  process.env.DEV_AUTH_USER_ID ?? "dcb1985e-3fe2-42fd-8978-7b04d1772850";

const WORKSHOP_NAME = "投研视频发布官";
const LOOP_NAME = "每日投研短视频制片";

const TRADER_WORKSHOP_ID = "57246c6d-7362-42ff-acb9-dd14257b3aff";
const HUNTER_WORKSHOP_ID = "3153b95e-df02-4d31-9949-04f19e4eb8d4";

const mission = [
  "你是投研视频发布官，负责把“操盘交易员”和“自选股猎手”每天的关键操作、判断依据、风险提示和复盘经验整理成可发布的短视频内容。",
  "",
  "核心目标：把工作台里的投研过程变成主人可复查、可审核、可发布的内容资产，而不是直接制造夸张观点或投资承诺。",
  "",
  "日常职责：",
  "1. 每个交易日收盘后读取操盘交易员和自选股猎手当天的工作记录、车间记忆、模拟盘账户、自选股调整提案、市场新闻和必要行情。",
  "2. 提炼当天最值得记录的 1-3 个主题：模拟盘操作、持仓变化、风险信号、自选股新增/移除逻辑、经验沉淀。",
  "3. 生成短视频脚本、分镜、视频生成提示词、标题、简介、话题标签、封面文案和风险提示。",
  "4. 先调用 videoRenderInvestmentBrief 生成真实本地视频；只有拿到本地成片路径 localPath 后，才允许创建抖音本地发布草稿。",
  "5. 上传、打开浏览器、定时发布、最终发布都必须进入审核，不允许静默外发。",
  "6. 内容必须说明“模拟盘/个人复盘/非投资建议”，不得承诺收益，不得制造确定性买卖结论。",
  "7. 每次运行都要用 workshopLogEvent 明确记录数据来源、脚本摘要、视频生成状态、抖音草稿状态和需要主人审核的动作。",
  "",
  "工程控制论口径：用反馈闭环管理内容质量。先观测事实，再形成脚本，再通过合规边界和主人审核形成控制动作；发布后的播放、评论和人工反馈应沉淀为下一轮内容策略记忆。",
].join("\n");

const boundaryPolicy = {
  mode: "draft",
  externalMessages: "draft",
  allowWechatPreview: false,
  requireSourcesForOutbox: true,
  allowedRecipients: [],
  maxMessageLength: 1600,
  minConfidenceToDraft: 75,
  minConfidenceToSend: 100,
  customInstructions: [
    "本车间只允许生产投研视频内容、创建本地抖音草稿和生成需要审核的发布计划。",
    "禁止真实证券交易、真实资金划转、真实券商连接和任何未审核的外部发布。",
    "禁止调用 quantPaperPlaceOrder、quantPaperCancelOrder、quantPaperProposeWatchlistChange。",
    "抖音上传/发布必须主人审核；没有 ownerApproved=true 和宿主环境允许变量时不得执行。",
    "所有内容必须包含模拟盘/非投资建议风险提示。",
  ].join("\n"),
};

const modelConfig = {
  role: "quant_video_publisher",
  market: "A股",
  contentPlatform: "douyin",
  videoMode: "real_video_generation_first",
  sourceWorkshopIds: [TRADER_WORKSHOP_ID, HUNTER_WORKSHOP_ID],
  requiredOutputLanguage: "zh-CN",
  allowedTools: [
    "workshopLogEvent",
    "workshopListSources",
    "workshopGetDirectives",
    "workshopReadLinkedWorkshopEvents",
    "workshopReadMemory",
    "workshopSearchMemory",
    "workshopWriteMemory",
    "quantPaperGetAccount",
    "quantPaperGetWatchlist",
    "aStockQuote",
    "aStockResearch",
    "aStockSignals",
    "aStockFundamentals",
    "aStockNewsAndFilings",
    "aStockMarketMood",
    "videoRenderInvestmentBrief",
    "douyinCheckAccount",
    "douyinCreatePublishDraft",
  ],
  requiresApprovalTools: ["douyinPrepareUpload", "douyinPublishApprovedDraft"],
  deniedTools: [
    "quantPaperPlaceOrder",
    "quantPaperCancelOrder",
    "quantPaperProposeWatchlistChange",
    "wechatCreateReplyDraft",
    "workshopCreateOutboxDraft",
  ],
};

const persistentDirectives = [
  [
    "每日制片流程：先汇总操盘交易员与自选股猎手当天记录，再交叉读取量化账户/自选股/新闻作为佐证；只把证据充分、可解释、适合公开表达的内容放入脚本。",
    "最终输出必须包含：sourceWorkshopDigest、tradingActions、watchlistActions、videoScript、storyboard、videoGenerationRequest、douyinDraftStatus、riskDisclosure、suggestedActions。",
    "先调用 videoRenderInvestmentBrief 生成真实视频；若返回 localPath，再调用 douyinCreatePublishDraft。若视频生成失败或超时，只记录 videoGenerationRequest/taskId，不得伪造草稿。",
  ].join("\n"),
  [
    "内容合规边界：不得承诺收益；不得使用“必涨、稳赚、抄底、满仓”等确定性表达；不得把模拟盘动作包装成实盘建议。",
    "标题和封面可以有吸引力，但必须准确反映来源事实，并保留“模拟盘复盘/非投资建议”的语义。",
  ].join("\n"),
  [
    "真实视频生成规则：把分镜、画面风格、旁白、字幕、时长、素材需求和风险提示整理成 videoGenerationRequest 后，调用 videoRenderInvestmentBrief。",
    "视频生成成功后，使用返回的 localPath 创建抖音发布草稿；视频生成失败、未完成或缺少 localPath 时，只记录生成状态和下一步处理建议。",
  ].join("\n"),
];

function videoLoopSpec(workshopId: string) {
  return parseLoopSpec({
    version: 1,
    templateId: "quant-daily-video-publisher",
    goal: [
      "每个交易日收盘后，把操盘交易员和自选股猎手当天的操作与复盘整理成抖音短视频生产包。",
      "先生成脚本、分镜、视频生成请求和发布文案，再调用真实视频生成工具；只有存在本地成片路径时才创建抖音本地草稿；上传和最终发布必须进入审核。",
    ].join("\n"),
    trigger: {
      type: "cron",
      expression: "40 18 * * 1-5",
      timezone: "Asia/Shanghai",
      tradingCalendar: "a-share",
      tradingDayOnly: true,
    },
    context: {
      sources: [
        {
          type: "memory",
          id: TRADER_WORKSHOP_ID,
          name: "操盘交易员车间",
          metadata: { sourceWorkshopId: TRADER_WORKSHOP_ID },
        },
        {
          type: "memory",
          id: HUNTER_WORKSHOP_ID,
          name: "自选股猎手车间",
          metadata: { sourceWorkshopId: HUNTER_WORKSHOP_ID },
        },
        {
          type: "connector",
          id: "douyin-publisher",
          name: "抖音发布器",
          metadata: { mode: "draft_and_approval_only" },
        },
        {
          type: "file",
          path: "tools/ai-release-video-agent",
          name: "视频生成流水线参考",
          metadata: { purpose: "video_generation_request_contract" },
        },
      ],
      instructions: [
        "第一步必须调用 workshopReadLinkedWorkshopEvents 读取绑定的操盘交易员车间和自选股猎手车间当天工作记录；不要先用通用业务搜索替代。",
        "用中文输出，页面展示尽量不要出现英文。",
        "先读取 workshop sources/directives/memory，再读取量化账户和自选股，必要时补充新闻与市场情绪。",
        "把操盘交易员当天的模拟盘操作与自选股猎手当天的自选股增删改建议分开归纳，避免混成单一观点。",
        "短视频建议 45-90 秒，结构为：今日一句话、发生了什么、为什么这么做、风险在哪里、明天看什么。",
        "生成 videoGenerationRequest 时写清楚：画面风格、镜头列表、旁白、字幕、图表素材、时长、分辨率、风险提示；随后调用 videoRenderInvestmentBrief。",
        "videoRenderInvestmentBrief 返回 localPath 后，可以调用 douyinCheckAccount 和 douyinCreatePublishDraft；若没有 localPath，douyinDraftStatus 必须写 pending_video_render，不得伪造草稿。",
        "douyinPrepareUpload / douyinPublishApprovedDraft 必须走审核。",
      ].join("\n"),
    },
    actions: {
      allowed: [
        "workshopLogEvent",
        "workshopListSources",
        "workshopGetDirectives",
        "workshopReadLinkedWorkshopEvents",
        "workshopReadMemory",
        "workshopSearchMemory",
        "workshopGetMemoryEvidence",
        "workshopWriteMemory",
        "searchUnifiedMemory",
        "searchMemoryPath",
        "quantPaperGetAccount",
        "quantPaperGetWatchlist",
        "aStockQuote",
        "aStockResearch",
        "aStockSignals",
        "aStockFundamentals",
        "aStockNewsAndFilings",
        "aStockMarketMood",
        "videoRenderInvestmentBrief",
        "douyinCheckAccount",
        "douyinCreatePublishDraft",
      ],
      requiresApproval: ["douyinPrepareUpload", "douyinPublishApprovedDraft"],
      denied: [
        "quantPaperPlaceOrder",
        "quantPaperCancelOrder",
        "quantPaperProposeWatchlistChange",
        "wechatCreateReplyDraft",
        "workshopCreateOutboxDraft",
        "Bash",
        "Write",
        "Edit",
      ],
    },
    verification: {
      type: "structured_check",
      requiredFields: [
        "sourceWorkshopDigest",
        "tradingActions",
        "watchlistActions",
        "videoScript",
        "storyboard",
        "videoGenerationRequest",
        "douyinDraftStatus",
        "riskDisclosure",
        "suggestedActions",
      ],
      requiredSources: [
        "操盘交易员",
        "自选股猎手",
        "量化工作台",
        "video_generation_model",
      ],
      successCriteria: [
        "清楚区分操盘交易员的模拟盘动作与自选股猎手的候选池/自选股动作。",
        "脚本、分镜、发布文案、话题和风险提示完整可读。",
        "真实视频生成失败、超时或缺少 localPath 时，只保留视频生成请求/taskId，不创建抖音草稿。",
        "任何上传或发布动作均进入审核，不得自动外发。",
        "内容包含模拟盘/非投资建议说明，且不承诺收益。",
      ],
      modelChecker: {
        enabled: false,
        maxInputChars: 20000,
      },
    },
    retry: {
      maxAttempts: 2,
      onFailure: "summarize_and_block",
    },
    approval: {
      defaultMode: "allow",
      externalWrites: "require_approval",
    },
    escalation: {
      onBlocked: "notify_user",
      onNeedsApproval: "notify_user",
    },
    metadata: {
      createdFrom: "seed-video-publisher-workshop",
      pipeline: "daily_quant_video_publish",
      workshopId,
      sourceWorkshopIds: [TRADER_WORKSHOP_ID, HUNTER_WORKSHOP_ID],
      targetPlatform: "douyin",
      publishBoundary: "owner_approval_required",
      modelCheckerReason:
        "Current project uses the app LLM stack; deterministic verification is used until loop modelChecker reuses that provider.",
      suggestedActionsDelivery: "internal_tasks",
      createOutboxDraftsFromSuggestedActions: false,
    },
  });
}

async function main() {
  const workshops = (await listWorkshops(USER_ID, 200)) as Workshop[];
  const existing = workshops.find((workshop) => workshop.name === WORKSHOP_NAME);
  const workshop = existing
    ? await updateWorkshop(USER_ID, existing.id, {
        mission,
        status: "active",
        autonomyLevel: "draft",
        boundaryPolicy,
        modelConfig,
      })
    : await createWorkshop({
        userId: USER_ID,
        name: WORKSHOP_NAME,
        mission,
        status: "active",
        autonomyLevel: "draft",
        boundaryPolicy,
        modelConfig,
      });

  if (!workshop) {
    throw new Error("Failed to create or update video publisher workshop");
  }

  const sources = (await listWorkshopSources(
    workshop.id,
    200,
  )) as WorkshopSource[];
  const ensureSource = async (source: Parameters<typeof addWorkshopSource>[0]) => {
    if (
      sources.some(
        (item) =>
          item.name === source.name &&
          item.type === source.type &&
          (item.uri ?? null) === (source.uri ?? null),
      )
    ) {
      return null;
    }
    return addWorkshopSource(source);
  };

  await ensureSource({
    workshopId: workshop.id,
    type: "knowledge",
    name: "操盘交易员车间",
    uri: `workshop://${TRADER_WORKSHOP_ID}`,
    content: "每日读取操盘交易员的工作记录、模拟盘操作、复盘和交易经验。",
    config: { sourceWorkshopId: TRADER_WORKSHOP_ID, role: "trading_actions" },
  });
  await ensureSource({
    workshopId: workshop.id,
    type: "knowledge",
    name: "自选股猎手车间",
    uri: `workshop://${HUNTER_WORKSHOP_ID}`,
    content: "每日读取自选股猎手的候选池、自选股增删改建议和选股经验。",
    config: { sourceWorkshopId: HUNTER_WORKSHOP_ID, role: "watchlist_actions" },
  });
  await ensureSource({
    workshopId: workshop.id,
    type: "connector",
    name: "抖音发布器",
    uri: "douyin://default",
    content: "用于检查账号、创建本地草稿和生成需要审核的上传/发布计划。",
    config: { approvalRequiredForUpload: true, approvalRequiredForPublish: true },
  });
  await ensureSource({
    workshopId: workshop.id,
    type: "file",
    name: "视频生成流水线参考",
    uri: "tools/ai-release-video-agent",
    content: "当前项目已接入百炼/DashScope 视频生成工具；先生成真实本地成片，再创建抖音草稿。若模型未配置或任务未完成，只记录 videoGenerationRequest/taskId。",
    config: { status: "reference_only" },
  });

  const directives = await listActiveDirectives(workshop.id, 100);
  for (const content of persistentDirectives) {
    if (!directives.some((directive) => directive.content === content)) {
      await addWorkshopDirective({
        workshopId: workshop.id,
        content,
        priority: 80,
        scope: "persistent",
      });
    }
  }

  const memories = await listWorkshopMemories(workshop.id, {
    limit: 100,
    includeCandidates: true,
  });
  const memoryContent =
    "投研视频发布官必须通过 videoRenderInvestmentBrief 获取真实本地成片路径后，才能创建抖音本地草稿；若模型调用失败或未完成，不得声称已生成视频。";
  if (!memories.some((memory) => memory.content === memoryContent)) {
    await addWorkshopMemory({
      workshopId: workshop.id,
      kind: "boundary",
      content: memoryContent,
      confidence: 95,
      tags: ["video", "douyin", "boundary", "model-gap"],
      status: "active",
    });
  }

  const spec = videoLoopSpec(workshop.id);
  const loops = await listLoopsForWorkshop({
    userId: USER_ID,
    workshopId: workshop.id,
    limit: 200,
  });
  const existingLoop = loops.find((loop) => loop.name === LOOP_NAME);
  const loopInput = loopSpecToCreateLoopInput({
    userId: USER_ID,
    workshopId: workshop.id,
    name: LOOP_NAME,
    description:
      "每个交易日收盘后，把两个投研车间的动作整理成短视频生产包，并在有成片时创建抖音本地草稿。",
    spec,
  });
  const loop = existingLoop
    ? await updateLoop(USER_ID, existingLoop.id, {
        workshopId: workshop.id,
        name: loopInput.name,
        description: loopInput.description,
        goal: loopInput.goal,
        status: "active",
        triggerConfig: loopInput.triggerConfig,
        contextConfig: loopInput.contextConfig,
        actionPolicy: loopInput.actionPolicy,
        verificationConfig: loopInput.verificationConfig,
        approvalPolicy: loopInput.approvalPolicy,
        retryPolicy: loopInput.retryPolicy,
        escalationPolicy: loopInput.escalationPolicy,
      })
    : await createLoop(loopInput);

  if (loop) {
    const existingState = await getLoopState(loop.id);
    await upsertLoopState(loop.id, {
      currentPhase: "idle",
      nextAction: null,
      blockedReason: null,
      lastObservation:
        "投研视频发布官配置已更新：使用绑定车间读取工具，内部建议不再进入发信草稿。",
      stateJson: {
        ...(existingState?.stateJson ?? {}),
        ...(loopInput.initialState?.stateJson ?? {}),
        lastSeededAt: new Date().toISOString(),
      },
    });
  }

  await appendWorkshopEvent({
    workshopId: workshop.id,
    loopId: loop?.id ?? existingLoop?.id ?? null,
    type: "setup",
    title: "投研视频发布车间已配置",
    body: "已接入操盘交易员、自选股猎手、量化数据和抖音草稿边界；每日交易日 18:40 生成短视频生产包。",
    metadata: {
      loopId: loop?.id ?? existingLoop?.id ?? null,
      trigger: spec.trigger,
      requiredFields: spec.verification.requiredFields,
      externalWrites: "require_approval",
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        userId: USER_ID,
        workshopId: workshop.id,
        workshopName: workshop.name,
        loopId: loop?.id ?? existingLoop?.id,
        loopName: LOOP_NAME,
        trigger: spec.trigger,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} finally {
  await closeDb();
}
