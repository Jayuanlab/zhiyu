"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Input, Textarea } from "@openzhiyu/ui";

type Peer = { id: string; name: string; role: string | null; mission: string; status: string; offeredCapabilities: string[]; acceptedKinds: string[] };
type Policy = { offeredCapabilities: string[]; acceptedKinds: string[]; allowedRecipients: string[] };
type Request = {
  id: string; requesterWorkId: string; recipientWorkId: string;
  requesterName: string; recipientName: string;
  kind: "notice" | "consult" | "delegate"; status: string;
  problem: string; desiredOutcome: string; whyHelpNeeded: string;
  acceptanceCriteria: string | null; response: string | null;
  resolutionNote: string | null; recipientRunId: string | null;
  recipientRunStatus: string | null; recipientRunError: string | null;
  recipientWorkStatus: string | null;
  dueAt: string; attentionReason: string | null; attentionAt: string | null;
  version: number; updatedAt: string;
};
type Event = { seq: number; actorType: string; actorWorkId: string | null; action: string; detail: string | null; createdAt: string };

const labels: Record<string, string> = {
  delivered: "已送达", accepted: "已接收", needs_info: "待补充资料",
  declined: "已拒绝", replied: "待发起方验证", verified: "已验证解决",
  cancelled: "已取消",
};

const attentionLabels: Record<string, string> = {
  response_overdue: "超过等待期限，尚未完成处理",
  recipient_run_completed_without_response: "接收方运行已结束，但没有留下回复",
  recipient_run_failed: "接收方运行失败，需要人工核对后再处理",
  recipient_run_interrupted: "接收方运行中断，需要人工核对后再处理",
  recipient_run_cancelled: "接收方运行已取消",
  recipient_run_needs_review: "接收方运行结果待核对",
};

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload as T;
}

export function CollaborationPanel({ workId }: { workId: string }) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [policy, setPolicy] = useState<Policy>({ offeredCapabilities: [], acceptedKinds: [], allowedRecipients: [] });
  const [policyVersion, setPolicyVersion] = useState(0);
  const [capabilitiesText, setCapabilitiesText] = useState("");
  const [requests, setRequests] = useState<Request[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<Request["kind"]>("consult");
  const [problem, setProblem] = useState("");
  const [outcome, setOutcome] = useState("");
  const [reason, setReason] = useState("");
  const [criteria, setCriteria] = useState("");
  const [detail, setDetail] = useState("");
  const [confirmedNoEffect, setConfirmedNoEffect] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [createCommand, setCreateCommand] = useState(() => crypto.randomUUID());
  const [actionCommand, setActionCommand] = useState(() => crypto.randomUUID());
  const base = `/api/workshops/${workId}/collaboration`;

  useEffect(() => {
    setSelected(null);
    setRequests([]);
    setPeers([]);
    setTarget("");
    setPolicy({ offeredCapabilities: [], acceptedKinds: [], allowedRecipients: [] });
    setCapabilitiesText("");
    setError("");
  }, [workId]);

  const refresh = useCallback(async () => {
    const data = await readJson<{ requests: Request[]; peers: Peer[] }>(base);
    setRequests(data.requests);
    setPeers(data.peers);
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    readJson<{ requests: Request[]; peers: Peer[] }>(base)
      .then((data) => { if (!cancelled) { setRequests(data.requests); setPeers(data.peers); } })
      .catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [base]);

  useEffect(() => {
    const timer = window.setInterval(() => { refresh().catch((cause) => setError(String(cause))); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    readJson<{ policy: Partial<Policy>; commandVersion: number }>(`${base}/policy`)
      .then((data) => {
        if (cancelled) return;
        const next = {
          offeredCapabilities: data.policy.offeredCapabilities ?? [],
          acceptedKinds: data.policy.acceptedKinds ?? [],
          allowedRecipients: data.policy.allowedRecipients ?? [],
        };
        setPolicy(next);
        setCapabilitiesText(next.offeredCapabilities.join(", "));
        setPolicyVersion(data.commandVersion);
      })
      .catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [base]);

  useEffect(() => {
    if (!selected) { setEvents([]); return; }
    let cancelled = false;
    readJson<{ events: Event[] }>(`${base}/${selected}`)
      .then((data) => { if (!cancelled) setEvents(data.events); })
      .catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [base, selected, requests]);

  async function create() {
    setPending(true); setError("");
    try {
      const created = await readJson<{ request: Request }>(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientWorkId: target, kind, problem, desiredOutcome: outcome,
          whyHelpNeeded: reason, acceptanceCriteria: kind === "notice" ? null : criteria,
          commandId: createCommand,
        }),
      });
      await refresh();
      setSelected(created.request.id);
      setProblem(""); setOutcome(""); setReason(""); setCriteria("");
      setCreateCommand(crypto.randomUUID());
    } catch (cause) { setError(String(cause)); }
    finally { setPending(false); }
  }

  async function act(request: Request, action: string) {
    setPending(true); setError("");
    try {
      await readJson(`${base}/${request.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, expectedVersion: request.version,
          detail, commandId: actionCommand }),
      });
      setDetail(""); setActionCommand(crypto.randomUUID());
      await refresh();
    } catch (cause) { setError(String(cause)); }
    finally { setPending(false); }
  }

  async function queueDelivery(request: Request) {
    setPending(true); setError("");
    try {
      await readJson(`${base}/${request.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "queue_delivery", expectedVersion: request.version,
          commandId: actionCommand, confirmedNoEffect,
          evidence: request.recipientRunId ? detail : "" }),
      });
      setDetail(""); setConfirmedNoEffect(false); setActionCommand(crypto.randomUUID());
      await refresh();
    } catch (cause) { setError(String(cause)); }
    finally { setPending(false); }
  }

  async function savePolicy() {
    setPending(true); setError("");
    try {
      const offeredCapabilities = capabilitiesText.split(/[,，]/).map((value) => value.trim()).filter(Boolean);
      const result = await readJson<{ policy: Policy; commandVersion: number }>(`${base}/policy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...policy, offeredCapabilities,
          expectedVersion: policyVersion, commandId: crypto.randomUUID() }),
      });
      setPolicy(result.policy);
      setCapabilitiesText(result.policy.offeredCapabilities.join(", "));
      setPolicyVersion(result.commandVersion);
      await refresh();
    } catch (cause) { setError(String(cause)); }
    finally { setPending(false); }
  }

  const current = requests.find((request) => request.id === selected);
  const role = (request: Request) => request.requesterWorkId === workId ? "发起" : "接收";
  const peerName = (id: string) => id === workId ? "当前智能体" : peers.find((peer) => peer.id === id)?.name ?? id;
  const recipientActions = current?.recipientWorkId === workId
    ? current.kind === "notice" && current.status === "delivered" ? ["acknowledge"]
      : current.status === "delivered" ? ["accept", "request_info", "decline"]
      : current.status === "accepted" ? ["reply", "request_info", "decline"] : []
    : [];
  const requesterActions = current?.requesterWorkId === workId
    ? current.status === "replied" ? ["verify", "cancel"]
      : current.status === "needs_info" ? ["provide_info", "cancel"]
      : ["delivered", "accepted"].includes(current.status) ? ["cancel"] : []
    : [];
  const canQueue = current?.requesterWorkId === workId
    && ["delivered", "accepted"].includes(current.status)
    && (!current.recipientRunId || ["failed", "interrupted", "cancelled"].includes(current.recipientRunStatus ?? ""));
  const isRetry = Boolean(current?.recipientRunId);
  const actionNames: Record<string, string> = {
    create: "发起请求",
    acknowledge: "确认已看到",
    accept: "接收", request_info: "请求补充", provide_info: "补充资料", decline: "拒绝",
    reply: "提交回复", verify: "验证解决", cancel: "取消",
    attention: "标记需关注",
    queue_delivery: "排队交给接收方",
  };

  return <div className="space-y-5 text-sm">
    <div>
      <h3 className="font-medium">同伴协作</h3>
      <p className="mt-1 text-xs text-muted-foreground">有问题需要其他智能体帮助时，留下请求、处理结果和验证记录。</p>
    </div>
    {error && <div role="alert" className="rounded-md border border-destructive p-3 text-destructive">{error}</div>}
    <section className="space-y-2 rounded-lg border p-3">
      <h4 className="font-medium">自主协作范围</h4>
      <p className="text-xs text-muted-foreground">明确此智能体能提供什么帮助、接收哪类请求，以及可以主动求助的对象。双方设置都允许后，智能体才能自动投递。</p>
      <label htmlFor="collab-capabilities" className="block text-xs">可提供的能力（逗号分隔）</label>
      <Input id="collab-capabilities" value={capabilitiesText} onChange={(event) => setCapabilitiesText(event.target.value)} placeholder="例如：记忆检索诊断, 文档整理" />
      <div className="space-y-1 text-xs">接收类型
        {["notice", "consult", "delegate"].map((value) => <label key={value} className="flex items-center gap-2">
          <input type="checkbox" checked={policy.acceptedKinds.includes(value)} onChange={(event) => setPolicy((current) => ({ ...current,
            acceptedKinds: event.target.checked ? [...current.acceptedKinds, value] : current.acceptedKinds.filter((item) => item !== value),
          }))} />{value === "notice" ? "提醒" : value === "consult" ? "咨询" : "委托"}
        </label>)}
      </div>
      <div className="space-y-1 text-xs">可主动求助的同伴
        {peers.map((peer) => <label key={peer.id} className="flex items-center gap-2">
          <input type="checkbox" checked={policy.allowedRecipients.includes(peer.id)} onChange={(event) => setPolicy((current) => ({ ...current,
            allowedRecipients: event.target.checked ? [...current.allowedRecipients, peer.id] : current.allowedRecipients.filter((item) => item !== peer.id),
          }))} />{peer.name}
        </label>)}
      </div>
      <Button type="button" variant="outline" disabled={pending} onClick={savePolicy}>保存协作范围</Button>
    </section>
    <section className="space-y-2 rounded-lg border p-3">
      <h4 className="font-medium">发起内部请求</h4>
      <p className="text-xs text-muted-foreground">这里提交的请求进入同伴收件箱，由你在页面上推动处理；智能体运行中自主求助才会自动排队唤醒对方。</p>
      <label className="block text-xs" htmlFor="collab-target">接收智能体</label>
      <select id="collab-target" value={target} onChange={(event) => setTarget(event.target.value)} className="w-full rounded-md border bg-background p-2">
        <option value="">选择同伴</option>
        {peers.filter((peer) => peer.status === "active").map((peer) => <option key={peer.id} value={peer.id}>{peer.name}{peer.role ? ` · ${peer.role}` : ""}</option>)}
      </select>
      {target && <p className="text-xs text-muted-foreground">{peers.find((peer) => peer.id === target)?.mission} · 可提供：{peers.find((peer) => peer.id === target)?.offeredCapabilities.join("、") || "尚未声明"} · 自动接收：{peers.find((peer) => peer.id === target)?.acceptedKinds.join("、") || "未开启"}</p>}
      <label className="block text-xs" htmlFor="collab-kind">请求类型</label>
      <select id="collab-kind" value={kind} onChange={(event) => setKind(event.target.value as Request["kind"])} className="w-full rounded-md border bg-background p-2">
        <option value="notice">提醒</option><option value="consult">咨询</option><option value="delegate">委托</option>
      </select>
      <Input aria-label="遇到的问题" placeholder="遇到的问题" value={problem} maxLength={4000} onChange={(event) => setProblem(event.target.value)} />
      <Input aria-label="希望得到的结果" placeholder="希望得到的结果" value={outcome} maxLength={2000} onChange={(event) => setOutcome(event.target.value)} />
      <Textarea aria-label="为什么需要帮助" placeholder="为什么需要这位同伴帮助" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
      {kind !== "notice" && <Textarea aria-label="如何验收" placeholder="如何判断帮助有效" value={criteria} maxLength={2000} onChange={(event) => setCriteria(event.target.value)} />}
      <Button disabled={pending || !target || !problem.trim() || !outcome.trim() || !reason.trim() || (kind !== "notice" && !criteria.trim())} onClick={create}>提交请求</Button>
    </section>
    <section className="space-y-2">
      <div className="flex items-center justify-between"><h4 className="font-medium">收件与发件</h4><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => refresh().catch((cause) => setError(String(cause)))}>刷新</Button></div>
      {requests.length === 0 && <p className="text-muted-foreground">暂无协作请求。</p>}
      {requests.map((request) => <button key={request.id} type="button" onClick={() => { setSelected(request.id); setDetail(""); setConfirmedNoEffect(false); setActionCommand(crypto.randomUUID()); }}
        className={`w-full rounded-lg border p-3 text-left ${selected === request.id ? "border-primary" : ""}`}>
        <span className="font-medium">{request.problem}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{role(request)} · {request.kind} · {labels[request.status] ?? request.status} · {request.requesterWorkId === workId ? request.recipientName : request.requesterName}</span>
        {request.attentionReason && <span className="mt-1 block text-xs text-destructive">需要关注：{attentionLabels[request.attentionReason] ?? request.attentionReason}</span>}
      </button>)}
    </section>
    {current && <section className="space-y-3 rounded-lg border p-3">
      <h4 className="font-medium">{current.problem}</h4>
      <p>目标：{current.desiredOutcome}</p><p>求助原因：{current.whyHelpNeeded}</p>
      {current.acceptanceCriteria && <p>验收：{current.acceptanceCriteria}</p>}
      {current.response && <p>回复：{current.response}</p>}
      {current.resolutionNote && <p>处理说明：{current.resolutionNote}</p>}
      {current.attentionReason && <p role="alert" className="rounded-md border border-destructive p-2 text-destructive">需要关注：{attentionLabels[current.attentionReason] ?? current.attentionReason}。请检查运行和协作记录，再决定是否取消或继续处理。</p>}
      {current.recipientRunId && <p className="text-xs text-muted-foreground">接收方运行：{current.recipientRunStatus ?? "状态未读到"} · {current.recipientRunId}{current.recipientRunError ? ` · ${current.recipientRunError}` : ""}</p>}
      {current.recipientWorkStatus && current.recipientWorkStatus !== "active" && <p className="text-xs text-destructive">接收智能体目前为 {current.recipientWorkStatus}，自动运行可能无法领取。</p>}
      <p className="text-xs text-muted-foreground">等待期限：{new Date(current.dueAt).toLocaleString()} · 最近更新：{new Date(current.updatedAt).toLocaleString()}</p>
      <div className="space-y-1 border-t pt-2" aria-label="协作记录">
        {events.map((event) => <p key={event.seq} className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()} · {event.actorType === "owner" ? "我" : event.actorWorkId ? peerName(event.actorWorkId) : "系统"} · {actionNames[event.action] ?? event.action}{event.detail ? ` · ${event.detail}` : ""}</p>)}
      </div>
      {([...recipientActions, ...requesterActions].length > 0 || canQueue) && <>
        <Textarea aria-label="处理说明" placeholder="回复、拒绝或验证的具体说明" value={detail} maxLength={4000} onChange={(event) => setDetail(event.target.value)} />
        {canQueue && <div className="space-y-2 rounded-md border p-2 text-xs">
          <p>{isRetry ? "旧运行已结束。重新投递前请核对其结果、外部动作和执行器状态；仅确认没有产生效果时才能重试。" : "将此请求交给接收智能体的受控运行队列。目标需已开启该类请求。"}</p>
          {isRetry && <label className="flex items-center gap-2"><input type="checkbox" checked={confirmedNoEffect} onChange={(event) => setConfirmedNoEffect(event.target.checked)} />我已核对旧运行没有产生外部效果，并在说明中写下证据</label>}
          <Button type="button" variant="outline" disabled={pending || (isRetry && (!confirmedNoEffect || detail.trim().length < 10))} onClick={() => queueDelivery(current)}>交给接收方运行</Button>
        </div>}
        <div className="flex flex-wrap gap-2">{[...recipientActions, ...requesterActions].map((action) =>
          <Button key={action} type="button" variant="outline" disabled={pending || (["reply", "decline", "request_info", "provide_info", "verify"].includes(action) && !detail.trim())} onClick={() => act(current, action)}>{actionNames[action]}</Button>)}</div>
      </>}
    </section>}
  </div>;
}
