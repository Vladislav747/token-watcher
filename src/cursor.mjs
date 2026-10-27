import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ProviderError, centsToUsd, meter, providerResult, titlePlan, toIso } from "./model.mjs";
import { requestJson, statusError } from "./net.mjs";

const execFileAsync = promisify(execFile);
const SUMMARY_URL = "https://cursor.com/api/usage-summary";
const PLAN_URL = "https://cursor.com/api/dashboard/get-plan-info";
const PERIOD_URL = "https://cursor.com/api/dashboard/get-current-period-usage";

export function jwtSubject(token) {
  const part = String(token).split(".")[1];
  if (!part) throw new ProviderError("error", "Токен Cursor не похож на сессию.");
  const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!payload?.sub) throw new ProviderError("error", "В сессии Cursor нет идентификатора аккаунта.");
  return String(payload.sub);
}

export function sessionCookie(token, { idOnly = false } = {}) {
  const subject = jwtSubject(token);
  const id = idOnly && subject.includes("|") ? subject.slice(subject.lastIndexOf("|") + 1) : subject;
  return `WorkosCursorSessionToken=${encodeURIComponent(id)}%3A%3A${token}`;
}

function percentMeter(id, label, usedPercent, resetsAt) {
  if (usedPercent == null || !Number.isFinite(Number(usedPercent))) return null;
  return meter({ id, label, usedPercent, resetsAt: toIso(resetsAt) });
}

function spendMeter(id, label, block) {
  if (!block?.enabled) return null;
  const used = centsToUsd(block.used);
  const limit = centsToUsd(block.limit);
  const remaining = centsToUsd(block.remaining);
  const usedPercent = used != null && limit != null && limit > 0 ? (used / limit) * 100 : null;
  return meter({
    id,
    label,
    usedPercent,
    used,
    limit,
    remaining: remaining ?? (used != null && limit != null ? Math.max(0, limit - used) : null),
    unit: "usd",
  });
}

export function isWeeklyPlan(planInfo) {
  const period = planInfo?.planInfo?.includedUsagePeriod ?? planInfo?.includedUsagePeriod;
  if (period == null) return false;
  if (period === 2 || period === "2") return true;
  return typeof period === "string" && /weekly/i.test(period);
}

export function mergeCursor({ summary, planInfo, period }) {
  const summaryPlan = summary?.individualUsage?.plan || {};
  const weekly = isWeeklyPlan(planInfo);
  const periodUsage = period?.planUsage || {};
  const periodPercent = periodUsage.totalPercentUsed;
  const summaryPercent = summaryPlan.totalPercentUsed;
  const resetsAt =
    planInfo?.planInfo?.includedUsageResetsAt ??
    period?.billingCycleEnd ??
    summary?.billingCycleEnd ??
    null;

  const meters = [];
  const summaryLooksEmpty =
    (summaryPercent == null || Number(summaryPercent) === 0) &&
    (summaryPlan.autoPercentUsed == null || Number(summaryPlan.autoPercentUsed) === 0) &&
    (summaryPlan.apiPercentUsed == null || Number(summaryPlan.apiPercentUsed) === 0);
  const usePeriod = periodPercent != null && (weekly || summaryLooksEmpty);

  if (usePeriod) {
    const week = percentMeter(weekly ? "week" : "period", weekly ? "Неделя" : "Период", periodPercent, resetsAt);
    if (week) meters.push(week);
  } else {
    const included = summaryPlan.breakdown?.total ?? summaryPlan.limit;
    const total = percentMeter("plan", "План", summaryPercent, summary?.billingCycleEnd);
    if (total) {
      const limit = centsToUsd(included);
      const used = limit != null && summaryPercent != null ? (limit * Number(summaryPercent)) / 100 : centsToUsd(summaryPlan.used);
      total.used = used;
      total.limit = limit;
      total.remaining = used != null && limit != null ? Math.max(0, limit - used) : centsToUsd(summaryPlan.remaining);
      total.unit = limit != null ? "usd" : "percent";
      meters.push(total);
    } else if (summary?.isUnlimited) {
      meters.push(meter({ id: "plan", label: "Без лимита", resetsAt: toIso(summary.billingCycleEnd) }));
    }

    const auto = percentMeter("auto", "Auto", summaryPlan.autoPercentUsed, summary?.billingCycleEnd);
    const api = percentMeter("api", "Именные модели", summaryPlan.apiPercentUsed, summary?.billingCycleEnd);
    if (auto) meters.push(auto);
    if (api) meters.push(api);
  }

  for (const item of [
    spendMeter("on_demand", "Сверх лимита", summary?.individualUsage?.onDemand),
    spendMeter("team_pooled", "Общий пул команды", summary?.teamUsage?.pooled),
    spendMeter("team_on_demand", "Сверх лимита команды", summary?.teamUsage?.onDemand),
  ]) {
    if (item) meters.push(item);
  }

  if (meters.length === 0) {
    throw new ProviderError("error", "Cursor изменил формат лимитов");
  }

  return {
    plan: titlePlan(summary?.membershipType),
    meters,
  };
}

export function stateDbPath() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

export function stateDbUri(dbPath = stateDbPath()) {
  const encoded = dbPath
    .split(path.sep)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `file:${encoded}?mode=ro`;
}

export async function loadCursorState() {
  const uri = stateDbUri();
  let stdout;
  try {
    const result = await execFileAsync(
      "/usr/bin/sqlite3",
      [
        "-json",
        uri,
        "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/cachedEmail','cursorAuth/stripeMembershipType');",
      ],
      { timeout: 8_000 },
    );
    stdout = result.stdout;
  } catch (error) {
    if (error?.code === "ENOENT" || /no such table|unable to open/i.test(String(error?.stderr || error?.message))) {
      throw new ProviderError("missing", "Cursor не установлен или в него не выполнен вход.");
    }
    throw new ProviderError("error", "Не удалось прочитать локальную сессию Cursor.");
  }

  let rows;
  try {
    rows = JSON.parse(stdout || "[]");
  } catch {
    throw new ProviderError("error", "Не удалось прочитать локальную сессию Cursor.");
  }
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const token = values["cursorAuth/accessToken"];
  if (!token) throw new ProviderError("missing", "Нет входа в Cursor. Войдите в редакторе.");
  return {
    token: String(token).trim(),
    email: values["cursorAuth/cachedEmail"] || null,
    plan: titlePlan(values["cursorAuth/stripeMembershipType"]),
  };
}

async function cursorGet(url, cookie, { method = "GET", body } = {}) {
  return requestJson(url, {
    method,
    body,
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      Origin: "https://cursor.com",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

export async function fetchCursor() {
  const name = "Cursor";
  try {
    const state = await loadCursorState();
    let cookie = sessionCookie(state.token);
    let summaryResponse = await cursorGet(SUMMARY_URL, cookie);
    if (summaryResponse.status === 401 || summaryResponse.status === 403) {
      cookie = sessionCookie(state.token, { idOnly: true });
      summaryResponse = await cursorGet(SUMMARY_URL, cookie);
    }

    if (!summaryResponse.json || summaryResponse.status >= 400) {
      const kind = statusError(summaryResponse.status);
      if (kind === "auth") {
        throw new ProviderError("auth", "Сессия Cursor истекла. Войдите в редактор ещё раз.");
      }
      if (kind === "rate") {
        throw new ProviderError("error", "Cursor просит подождать: слишком частые запросы.");
      }
      throw new ProviderError("error", `Cursor ответил ${summaryResponse.status || "ошибкой сети"}.`);
    }

    const [planInfo, period] = await Promise.all([
      cursorGet(PLAN_URL, cookie, { method: "POST", body: "{}" }),
      cursorGet(PERIOD_URL, cookie, { method: "POST", body: "{}" }),
    ]);

    const parsed = mergeCursor({
      summary: summaryResponse.json,
      planInfo: planInfo.ok ? planInfo.json : null,
      period: period.ok ? period.json : null,
    });

    return providerResult({
      id: "cursor",
      name,
      plan: parsed.plan || state.plan,
      account: state.email,
      meters: parsed.meters,
    });
  } catch (error) {
    if (error instanceof ProviderError) return providerResult({ id: "cursor", name, status: error.status, message: error.message });
    return providerResult({
      id: "cursor",
      name,
      status: "error",
      message: error instanceof Error ? error.message : "Cursor недоступен",
    });
  }
}
