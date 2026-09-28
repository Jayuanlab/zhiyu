import type { AgentMessage } from "@openzhiyu/ai/agent/types";

const uuidInText = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
const maxBufferedAnswerCharacters = 64_000;

type RuntimeEvidence = {
  status: string;
  loopId: string;
  observedAt: string;
  loopConfiguration?: { status?: string; updatedAt?: string | null } | null;
};

/** Only a single, exact Loop's present executor state is eligible for this guard. */
export function directLoopRuntimeQuestionId(question: string): string | null {
  const ids = [...new Set((question.match(uuidInText) ?? []).map(id => id.toLowerCase()))];
  const labeledLoopId = question.match(/\bloop\s*(?:id)?\s*[:：#]?\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i)?.[1]?.toLowerCase();
  return ids.length === 1
    && labeledLoopId === ids[0]
    && /现在|当前|目前|此刻|实时|回答瞬间|正在|\bnow\b|\bcurrent(?:ly)?\b/i.test(question)
    && /运行|执行器|租约|心跳|在线|存活|\brunn?ing\b|\bexecutor\b|\blease\b|\bheartbeat\b/i.test(question)
    ? ids[0] : null;
}

function runtimeFromResult(message: AgentMessage, loopId: string): RuntimeEvidence | null {
  if (message.isError || typeof message.output !== "string") return null;
  let payload: any;
  try { payload = JSON.parse(message.output); } catch { return null; }
  if (payload?.ok === false) return null;
  const runtime = payload?.data?.runtimeObservation ?? payload?.runtime ?? payload;
  if (runtime?.provider !== "workshop_execution_leases"
    || typeof runtime.loopId !== "string" || runtime.loopId.toLowerCase() !== loopId
    || !["no_active_linked_execution_observed", "not_currently_verified", "active_lease_recent_heartbeat"].includes(runtime.status)
    || typeof runtime.observedAt !== "string" || !Number.isFinite(Date.parse(runtime.observedAt))
    || (runtime.status === "no_active_linked_execution_observed"
      && (runtime.observationScope !== "active_linked_execution_mapping_only" || runtime.linkedExecution !== null))) return null;
  return runtime;
}

function unsupportedClaims(answer: string, runtime: RuntimeEvidence | null): string[] {
  if (!runtime) return ["runtime_observation_missing"];
  const sentences = answer.split(/[。！？\n]/u);
  const risks: string[] = [];
  if (runtime.status === "no_active_linked_execution_observed" && sentences.some(sentence =>
    !/(?:不能|不可|不应|严禁|不要).{0,30}(?:表述为|说成|写成|声称)/u.test(sentence)
    && /(?:未观察到|未检测到|没有|未发现)(?:(?:活动|活跃)的?)?(?:执行器)?(?:租约|心跳)/u.test(sentence))) {
    risks.push("lease_heartbeat_absence_claim_without_evaluation");
  }
  if (sentences.some(sentence =>
    !/(?:不能|无法|不可|不应|不要|未验证|未知|不能证明|无法断定)/u.test(sentence)
    && (/(?:很可能|极可能|大概率|可能性很高).{0,40}(?:非活跃|阻塞|等待干预|仍处于|未运行|不在运行|停滞|已停止|中断)/u.test(sentence)
      || /(?:此刻|现在|目前|当前|回答瞬间).{0,50}(?:执行器|Loop|loop).{0,50}(?:已停止|已停机|空闲|非活跃|不在运行|仍处于阻塞|仍在运行)/iu.test(sentence)
      || /(?:此刻|现在|目前|当前|回答瞬间).{0,50}(?:执行器|Loop|loop).{0,50}(?:正在运行|仍在线|确定在线|已经停止)/iu.test(sentence)
      || /(?:无活动|没有活动|未观察到活动).{0,60}(?:所以|因此|说明|证明).{0,30}(?:已停止|不在运行|空闲|非活跃)/u.test(sentence)))) {
    risks.push("live_runtime_claim_without_observation");
  }
  return risks;
}

function conservativeAnswer(loopId: string, runtime: RuntimeEvidence | null): string {
  if (!runtime) return `Loop ${loopId} 的当前执行状态未核实：本轮未取得该 Loop 可用的执行观测。请稍后重试或在车间查看运行记录；我不能据此判断它现在是否运行。`;
  const configuration = runtime.loopConfiguration;
  const configText = configuration && typeof configuration.status === "string"
    ? `任务配置在读取时为 ${configuration.status}${configuration.updatedAt ? `（配置更新时间 ${configuration.updatedAt}）` : ""}；这不是执行器活动状态。`
    : "本次观测没有可核对的任务配置状态。";
  if (runtime.status === "no_active_linked_execution_observed") {
    return `Loop ${loopId}：${configText}数据库于 ${runtime.observedAt} 未查到活动的 Loop 与执行记录关联映射。由于没有该映射，本次没有评估该 Loop 的执行租约或心跳；回答时执行器是否仍在运行未知，不能据此推断已停止、阻塞或故障原因。`;
  }
  const runtimeText = runtime.status === "active_lease_recent_heartbeat"
    ? "观察到匹配的有效租约与近期心跳"
    : "未能核实正在活动的执行器";
  return `Loop ${loopId}：${configText}数据库于 ${runtime.observedAt} ${runtimeText}。这只描述读取时的证据，不能证明回答瞬间的进程状态。`;
}

/** Hold only answer tokens; tool evidence and control/error events remain visible. */
export async function* guardDirectLoopRuntimeAnswer(
  source: AsyncGenerator<AgentMessage>, question: string,
): AsyncGenerator<AgentMessage> {
  const loopId = directLoopRuntimeQuestionId(question);
  if (!loopId) { yield* source; return; }
  const toolNames = new Map<string, string>();
  let runtime: RuntimeEvidence | null = null;
  const answerEvents: AgentMessage[] = [];
  let answer = "";
  let streamedText = false;
  let overflow = false;
  let failed = false;
  let done: AgentMessage | null = null;
  for await (const event of source) {
    if (event.type === "tool_use" && event.id && event.name) toolNames.set(event.id, event.name);
    if (event.type === "tool_result" && event.toolUseId && toolNames.get(event.toolUseId) === "platformRecall") {
      const observation = runtimeFromResult(event, loopId);
      if (observation && (!runtime || Date.parse(observation.observedAt) >= Date.parse(runtime.observedAt))) runtime = observation;
    }
    if (event.type === "text" || event.type === "result" || event.type === "direct_answer") {
      if (!overflow) {
        answerEvents.push(event);
        if (event.type === "text") streamedText = true;
        if (event.type !== "result" || (!streamedText && event.content !== "success")) answer += event.content ?? "";
        if (answer.length > maxBufferedAnswerCharacters) { overflow = true; answerEvents.length = 0; answer = ""; }
      }
    } else if (event.type === "done") done = event;
    else {
      if (event.type === "error") { failed = true; answerEvents.length = 0; }
      yield event;
    }
  }
  if (failed) { if (done) yield done; return; }
  const risks = overflow ? ["answer_buffer_limit"] : unsupportedClaims(answer, runtime);
  if (risks.length) {
    console.warn("[LoopRuntimeAnswerGuard] Replaced unsupported answer", { loopId, reasons: risks,
      observationStatus: runtime?.status ?? "missing" });
    const content = conservativeAnswer(loopId, runtime);
    yield { type: "text", content, messageId: crypto.randomUUID() };
    yield { type: "result", content: "success" };
  } else {
    for (const event of answerEvents) yield event;
  }
  if (done) yield done;
}
