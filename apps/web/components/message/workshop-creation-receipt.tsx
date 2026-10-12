type ReceiptProps = { toolName: string; status?: string; toolOutput?: unknown };
const workshopIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Display a verified business receipt independently of the tool accordion. */
export function WorkshopCreationReceipt({ toolName, status, toolOutput }: ReceiptProps) {
  if (toolName !== "applyWorkshopManifestYaml" ||
    (status !== "completed" && status !== "error")) return null;
  let value = toolOutput;
  if (typeof value === "string") {
    if (value.length > 64_000) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const verified = status === "completed" && result.ok === true && result.status === "created_verified";
  const pending = result.ok === false && result.status === "created_readback_pending";
  if (!verified && !pending) return null;
  const workshop = result.workshop && typeof result.workshop === "object" && !Array.isArray(result.workshop)
    ? result.workshop as Record<string, unknown> : null;
  const id = verified ? workshop?.id : result.workshopId;
  if (typeof id !== "string" || !workshopIdPattern.test(id)) return null;
  const name = verified && typeof workshop?.name === "string" ? workshop.name : null;
  // Construct a local route from the actual receipt ID, never an output URL.
  const href = `/workshop?workId=${encodeURIComponent(id)}`;
  return <div role="status" className={verified
    ? "mt-2 rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm dark:border-emerald-900 dark:bg-emerald-950/20"
    : "mt-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/20"}>
    <p className="font-medium">{verified ? "智能体已创建并核对" : "创建结果待核对"}{name ? `：${name}` : ""}</p>
    {pending ? <p className="mt-1 text-xs text-muted-foreground">创建已提交，暂未完成结果回读。请先核对现有智能体，避免重复创建。</p> : null}
    <a href={href} className="mt-1 inline-block underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
      {verified ? "查看智能体" : "打开车间核对"}
    </a>
  </div>;
}
