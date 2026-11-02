import { startModelProviderFixture } from './model-provider-fixture.mjs';
export async function startPersonalDayProviderFixture() {
  return startModelProviderFixture({
    text(body) {
      const messages = body.messages ?? [];
      const last = messages.findLast((m) => m.role === 'user');
      const raw =
        typeof last?.content === 'string'
          ? last.content
          : (last?.content ?? []).map((p) => p.text ?? '').join('');
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        return '{}';
      }
      if (input.task === 'source_principles')
        return JSON.stringify({
          principles: [
            '提供文字第 1 段：按个人已确认条件安排，保留休息与实际执行记录；仅作待核对参考。',
          ],
        });
      const toMinute = (time) =>
          Number(time.slice(0, 2)) * 60 + Number(time.slice(3)),
        clock = (m) =>
          String(Math.floor(m / 60)).padStart(2, '0') +
          ':' +
          String(m % 60).padStart(2, '0');
      const context = structuredClone(input.context),
        change = input.reason?.match(/加班.*?(\d{1,2})(?:点|:00)/);
      if (change) {
        const after = Number(change[1]) * 60;
        context.windows = context.windows
          .filter((w) => toMinute(w.end) > after)
          .map((w) => ({
            ...w,
            start: clock(Math.max(toMinute(w.start), after)),
          }));
        context.location = 'home';
        if (/外食|不做饭|没法.*做饭/.test(input.reason))
          context.meals = 'outside';
      }
      const nowMinutes =
        input.date ===
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date())
          ? toMinute(
              new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Asia/Shanghai',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
              }).format(new Date()),
            ) + 5
          : 0;
      const overlap = (a, b) => a.start < b.end && b.start < a.end;
      const occupied = [
          ...context.fixed,
          ...(input.previous ?? []).filter(
            (i) =>
              i.status !== 'planned' ||
              context.windows.some((w) => w.start <= i.start && w.end >= i.end),
          ),
        ],
        items = [];
      const picks = [
        ...['breakfast', 'lunch', 'dinner'].map((meal) => ({
          kind: 'meal',
          entry: input.mealChoices?.find(
            (r) =>
              r.meal === meal &&
              (context.meals === 'mixed' || r.mode === context.meals),
          ),
          from: meal === 'breakfast' ? 360 : meal === 'lunch' ? 660 : 1020,
          to: meal === 'breakfast' ? 630 : meal === 'lunch' ? 900 : 1410,
        })),
        {
          kind: 'exercise',
          entry:
            input.exerciseChoices?.find((e) => e.id === 'walk_short') ??
            input.exerciseChoices?.[0],
          from: 360,
          to: 1410,
        },
      ];
      for (const pick of picks) {
        if (!pick.entry) continue;
        let placed = false;
        for (const w of context.windows) {
          for (
            let t = Math.max(toMinute(w.start), pick.from, nowMinutes);
            t + pick.entry.minutes <= Math.min(toMinute(w.end), pick.to);
            t += 5
          ) {
            const entry = {
              start: clock(t),
              end: clock(t + pick.entry.minutes),
            };
            if (
              occupied.some(
                (i) =>
                  !['skipped', 'canceled'].includes(i.status) &&
                  overlap(i, entry),
              )
            )
              continue;
            items.push({
              kind: pick.kind,
              catalogId: pick.entry.id,
              start: entry.start,
            });
            occupied.push(entry);
            placed = true;
            break;
          }
          if (placed) break;
        }
      }
      return JSON.stringify({
        summary:
          '回环协议夹具生成的日计划，按时间与目录核对；不是阿里真实模型的健康判断。',
        items,
        citations: [
          'guideline:activity',
          'guideline:diet',
          ...(input.principles ?? []).map((s) => s.sourceId),
        ],
        ...(change ? { proposedContext: context } : {}),
      });
    },
  });
}
