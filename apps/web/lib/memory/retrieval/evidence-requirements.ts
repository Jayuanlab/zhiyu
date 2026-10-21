export type FieldCheck = { evidenceId: string; field: string; state: "present" | "null" | "empty" | "missing" | "truncated" };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Only enforce recognized record fields, never infer a schema from prose memories. */
export function prepareRecordEvidence(question: string, items: Array<{ id: string; content: string }>) {
  const fields: string[] = [];
  const explicit = question.match(/这些字段原值分别是什么[：:]([^？?]+)/u);
  if (explicit) fields.push(...explicit[1].split(/[、,，]/u).map(value => value.trim()).filter(value => /^[a-z][a-z0-9_]*$/i.test(value)));
  if (/何时发生|何时生成|生成时间|事件发生时间/u.test(question)) fields.push("created_at");
  if (/保存了什么状态/u.test(question)) fields.push("content");
  if (/依据哪些记忆/u.test(question)) fields.push("source_memory_ids");
  if (/属于哪个范围/u.test(question)) fields.push("scope_type", "scope_id");
  const required = [...new Set(fields)];
  const checks: FieldCheck[] = [];
  let truncated = false;
  const requestedIds = question.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  const evidence = items.flatMap(item => {
    let parsed: unknown;
    try { parsed = JSON.parse(item.content); } catch { return item; }
    if (!object(parsed)) return item;
    const record = object(parsed.fields) ? parsed.fields : parsed;
    const isRecord = object(parsed.fields) || /^db:/.test(item.id) || /^[a-zA-Z_]+:[0-9a-f-]{36}$/i.test(item.id);
    const applies = isRecord && (!requestedIds.length || requestedIds.some(id => item.id.includes(id) || parsed.recordId === id || record.id === id));
    const selected: Record<string, unknown> = {};
    const omittedFields: string[] = [];
    const chunkedFields: string[] = [];
    const chunks: Array<{ id: string; content: string }> = [];
    let remaining = 1500;
    // Short required values first: a long body must never displace timestamps.
    const keys = Object.keys(record).sort((a, b) => Number(required.includes(b)) - Number(required.includes(a)) || JSON.stringify(record[a]).length - JSON.stringify(record[b]).length);
    for (const key of keys) {
      const size = JSON.stringify({ [key]: record[key] }).length;
      if (size <= remaining) { selected[key] = record[key]; remaining -= size; }
      else {
        const value = JSON.stringify(record[key]);
        if (value.length > 12000) { omittedFields.push(key); truncated = true; continue; }
        chunkedFields.push(key);
        for (let offset = 0; offset < value.length; offset += 700) {
          chunks.push({ id: `${item.id}#${key}:${offset}`, content: JSON.stringify({ recordEvidenceId: item.id, field: key, encoding: "JSON fragments; concatenate in offset order", offset, totalCharacters: value.length, fragment: value.slice(offset, offset + 700) }) });
        }
      }
    }
    if (applies) for (const field of required) {
      const alias = field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      const key = Object.hasOwn(record, field) ? field : Object.hasOwn(record, alias) ? alias : field;
      checks.push({ evidenceId: item.id, field, state: !Object.hasOwn(record, key) ? "missing" : omittedFields.includes(key) ? "truncated" : record[key] === null ? "null" : Array.isArray(record[key]) && record[key].length === 0 ? "empty" : "present" });
    }
    return [{ id: item.id, content: JSON.stringify({ fields: selected, omittedFields, chunkedFields,
      ...(object(parsed.fields) ? { capturedAt: parsed.capturedAt, recordId: parsed.recordId } : {}),
      packing: "Field projection; omitted fields are unavailable, not null. capturedAt is acquisition time, never event or creation time.",
    }) }, ...chunks];
  });
  return { evidence, checks, truncated, required };
}
