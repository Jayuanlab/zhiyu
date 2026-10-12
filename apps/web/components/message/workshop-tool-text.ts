const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set([
  "reviewWorkshopManifestYaml", "applyWorkshopManifestYaml", "inspectWorkshopAgent", "runWorkshopOnce",
  "discoverWorkshops", "describeWorkshop", "observeWorkshop", "runWorkshopMission", "askWorkshop",
  "assignWorkshopTask", "amendWorkshopRun", "cancelWorkshopRun", "retryWorkshopRun",
  "setWorkshopAvailability", "prepareWorkshopManifest", "applyPreparedWorkshop", "deleteWorkshop",
  "proposeWorkshopLoop", "setWorkshopLoopStatus", "executeWorkshopLoop", "configureWorkshopSource",
  "proposeWorkshopMemory", "proposeWorkshopConfiguration", "decideWorkshopReview", "draftWorkshopMessage",
  "sendWorkshopMessage", "resolveWorkshopMessage", "requestWorkshopCollaboration",
  "deliverWorkshopCollaboration", "respondWorkshopCollaboration",
]);
const RUN_LABELS: Record<string, string> = {
  queued: "本轮已排队，等待执行。", running: "本轮正在执行。", completed: "本轮运行已完成。",
  failed: "本轮运行失败。", interrupted: "本轮运行已中断。", cancelled: "本轮运行已取消。",
  cancel_requested: "已请求停止本轮，执行器停止尚待确认。", needs_review: "本轮执行结果需要核对。",
};
type Feedback = { text: string; href?: string; linkText?: string };
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function body(value: unknown) {
  if (typeof value === "string") {
    if (value.length > 256_000) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  const envelope = record(value);
  return envelope?.status === "success" ? record(envelope.result) : envelope;
}
export function isWorkshopChatTool(toolName: string) { return OPERATIONS.has(toolName); }

/** Render host facts as ordinary prose; never infer effects from assistant wording. */
export function workshopToolText(toolName: string, status: string | undefined, toolOutput: unknown): Feedback | null {
  if (!isWorkshopChatTool(toolName) || !["completed", "error"].includes(status ?? "")) return null;
  const result = body(toolOutput);
  if (!result) return status === "error" ? { text: "本次车间操作未取得可核验回执，请核对原请求。" } : null;
  const workshop = record(result.workshop), run = record(result.run);
  if (toolName === "applyWorkshopManifestYaml") {
    const verified = status === "completed" && result.ok === true && result.status === "created_verified";
    const pending = result.ok === false && result.status === "created_readback_pending";
    const id = verified ? workshop?.id : result.workshopId;
    if ((!verified && !pending) || typeof id !== "string" || !UUID.test(id)) return null;
    return { text: verified ? "智能体已创建并核对。" : "创建已提交，结果回读尚未确认，请核对原请求。",
      href: `/workshop?workId=${encodeURIComponent(id)}`, linkText: "查看智能体" };
  }
  if (toolName === "runWorkshopOnce") {
    const workId = result.workshopId ?? workshop?.id;
    const runId = run?.id ?? result.runId;
    if (typeof workId !== "string" || !UUID.test(workId) || typeof runId !== "string" || !UUID.test(runId) ||
        (run && run.workshopId !== workId) || (workshop && workshop.id !== workId)) return null;
    const accepted = status === "completed" && result.ok === true && ["run_accepted", "run_observed"].includes(String(result.status));
    const pending = result.ok === false && result.status === "run_readback_pending";
    if (!pending && (!accepted || typeof run?.status !== "string" || !RUN_LABELS[run.status])) return null;
    return { text: pending ? "本轮已提交，状态回读尚未确认，请核对同一轮。" : RUN_LABELS[String(run?.status)],
      href: `/workshop?workId=${encodeURIComponent(workId)}&runId=${encodeURIComponent(runId)}`, linkText: "查看本轮记录" };
  }
  if (["reviewWorkshopManifestYaml", "prepareWorkshopManifest"].includes(toolName)) {
    const review = record(result.review);
    if (typeof review?.ok !== "boolean") return null;
    return { text: review.ok ? "配置检查通过，尚未创建智能体。" : "配置检查未通过，尚未创建智能体。" };
  }
  if (["assignWorkshopTask", "askWorkshop", "setWorkshopAvailability", "cancelWorkshopRun"].includes(toolName)) {
    const workId = result.workshopId, detail = record(result.result);
    const link = typeof workId === "string" && UUID.test(workId) ? {
      href: `/workshop?workId=${encodeURIComponent(workId)}${typeof detail?.runId === "string" && UUID.test(detail.runId) ? `&tab=run&runId=${detail.runId}` : ""}`, linkText: "查看工作记录",
    } : {};
    if (result.ok === false) return { text: typeof result.message === "string" ? result.message : "本次车间操作未成功，请核对原命令。", ...link };
    if (result.ok !== true || !detail) return null;
    if (detail.status === "queued") return { text: result.replayed === true ? "已找回原交办回执，未创建新运行；当前进展可查看原记录。" : "交办已受理，等待后台执行；后续结果会回到此对话。", ...link };
    if (result.replayed === true) return { text: "已找回原操作回执，未重复执行；当前状态请查看原记录。", ...link };
    if (detail.status === "future_paused") return { text: "后续运行已暂停，当前运行继续；原排队事项保留暂停。", ...link };
    if (typeof detail.status === "string" && RUN_LABELS[detail.status]) return { text: RUN_LABELS[detail.status]
      + (detail.futurePaused === true ? " 后续运行已暂停，原队列保留暂停。" : "")
      + (detail.executorExitVerified === false ? " 执行器退出及已发生效果仍需核对。" : ""), ...link };
  }
  if (result.interfaceVersion === "workshop-agent-operation.v1" && result.operationId === toolName) {
    const receipt = record(result.receipt), ids = record(receipt?.ids), error = record(result.error);
    const workId = ids?.workId, runId = ids?.runId;
    const link = typeof workId === "string" && UUID.test(workId) ? {
      href: `/workshop?workId=${encodeURIComponent(workId)}${typeof runId === "string" && UUID.test(runId) ? `&runId=${encodeURIComponent(runId)}` : ""}`,
      linkText: "查看工作记录",
    } : {};
    if (receipt?.readbackStatus === "pending") return { text: "操作已提交，结果回读尚未确认，请核对原请求。", ...link };
    if (result.ok === false) return { text: `本次车间操作返回异常：${typeof error?.message === "string" ? error.message.slice(0, 2000) : "原因待核对。"}`, ...link };
    if (result.ok === true && typeof receipt?.runStatus === "string" && RUN_LABELS[receipt.runStatus]) {
      return { text: RUN_LABELS[receipt.runStatus], ...link };
    }
  }
  return null;
}
