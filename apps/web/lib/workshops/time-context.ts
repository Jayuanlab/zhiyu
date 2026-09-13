import { nextAShareTradingDay } from "@/lib/markets/a-share-trading-calendar";

export interface WorkshopRunTimeContext {
  timezone: string;
  utcIso: string;
  localDate: string;
  localTime: string;
  weekday: string;
  localDateWithWeekday: string;
  nextAShareTradingDay: string;
  nextAShareTradingDayWithWeekday: string;
}

function partValue(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function normalizeHour(hour: string) {
  return hour === "24" ? "00" : hour;
}

export function buildWorkshopRunTimeContext(input?: {
  now?: Date;
  timezone?: string | null;
}): WorkshopRunTimeContext {
  const now = input?.now ?? new Date();
  const timezone = input?.timezone?.trim() || "Asia/Shanghai";
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const year = partValue(dateParts, "year");
  const month = partValue(dateParts, "month");
  const day = partValue(dateParts, "day");
  const hour = normalizeHour(partValue(dateParts, "hour"));
  const minute = partValue(dateParts, "minute");
  const second = partValue(dateParts, "second");
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    weekday: "short",
  }).format(now);
  const localDate = `${year}-${month}-${day}`;
  const nextTradingDay = nextAShareTradingDay(now);
  const nextTradingDayDate = nextTradingDay.date;
  const nextTradingDayWeekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(`${nextTradingDayDate}T00:00:00+08:00`));

  return {
    timezone,
    utcIso: now.toISOString(),
    localDate,
    localTime: `${hour}:${minute}:${second}`,
    weekday,
    localDateWithWeekday: `${localDate} (${weekday})`,
    nextAShareTradingDay: nextTradingDayDate,
    nextAShareTradingDayWithWeekday: `${nextTradingDayDate}（${nextTradingDayWeekday}）`,
  };
}

export function formatWorkshopRunTimeContext(
  context: WorkshopRunTimeContext,
) {
  return JSON.stringify(context, null, 2);
}
