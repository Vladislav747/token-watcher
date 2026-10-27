import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderError, meter, providerResult, titlePlan, toIso } from "./model.mjs";
import { requestJson, statusError } from "./net.mjs";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const PLAN_NAMES = {
  prolite: "Pro 5x",
  pro: "Pro 20x",
  plus: "Plus",
  team: "Team",
};

export function classifyCodexWindow(window) {
  if (!window) return null;
  const seconds = Number(window.limit_window_seconds);
  if (seconds > 0 && seconds <= 6 * 3600) return { id: "session", label: "5 часов" };
  if (seconds >= 6 * 24 * 3600) return { id: "weekly", label: "Неделя" };
  return { id: "window", label: "Лимит" };
}

export function parseCodexUsage(body) {
  const raw = typeof body === "string" ? JSON.parse(body) : body;
  if (!raw || typeof raw !== "object") {
    throw new ProviderError("error", "Codex вернул пустой ответ");
  }

  const meters = [];
  const windows = [raw.rate_limit?.primary_window, raw.rate_limit?.secondary_window].filter(Boolean);
  for (const window of windows) {
    const kind = classifyCodexWindow(window);
    if (!kind || window.used_percent == null) continue;
    meters.push(
      meter({
        id: kind.id,
        label: kind.label,
        usedPercent: window.used_percent,
        resetsAt: toIso(window.reset_at),
      }),
    );
  }

  for (const extra of raw.additional_rate_limits || []) {
    const window = extra?.window;
    if (!window || window.used_percent == null) continue;
    meters.push(
      meter({
        id: extra.name || "extra",
        label: extra.name || "Дополнительный лимит",
        usedPercent: window.used_percent,
        resetsAt: toIso(window.reset_at),
      }),
    );
  }

  const credits = raw.credits;
  if (credits?.unlimited) {
    meters.push(meter({ id: "credits", label: "Кредиты без лимита", unit: "credits" }));
  } else if (credits?.balance != null && credits.balance !== "" && credits.balance !== "0") {
    const balance = Number(credits.balance);
    if (Number.isFinite(balance)) {
      meters.push(meter({ id: "credits", label: "Кредиты", unit: "credits", remaining: balance }));
    }
  }

  if (!meters.some((item) => item.usedPercent != null)) {
    throw new ProviderError("error", "Codex изменил формат лимитов");
  }

  return {
    plan: titlePlan(raw.plan_type, PLAN_NAMES),
    account: raw.email || null,
    meters,
  };
}

function authPaths() {
  if (process.env.CODEX_HOME) return [path.join(process.env.CODEX_HOME, "auth.json")];
  return [
    path.join(os.homedir(), ".codex", "auth.json"),
    path.join(os.homedir(), ".config", "codex", "auth.json"),
  ];
}

export async function loadCodexAuth() {
  for (const file of authPaths()) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError("error", "Файл входа Codex повреждён.");
    }
    const token = parsed?.tokens?.access_token;
    if (!token) continue;
    return {
      token,
      accountId: parsed.tokens.account_id || parsed.tokens.accountId || "",
    };
  }
  throw new ProviderError(
    "missing",
    "Нет входа Codex. Выполните codex login.",
  );
}

export async function fetchCodex() {
  const name = "Codex";
  try {
    const auth = await loadCodexAuth();
    const headers = {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/json",
      "User-Agent": "ai-karma/0.1",
    };
    if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

    const { status, json } = await requestJson(USAGE_URL, { headers });
    if (!json || status >= 400) {
      const kind = statusError(status);
      if (kind === "auth") {
        throw new ProviderError("auth", "Сессия Codex истекла. Выполните codex login.");
      }
      if (kind === "rate") {
        throw new ProviderError("error", "Codex просит подождать: слишком частые запросы.");
      }
      throw new ProviderError("error", `Codex ответил ${status || "ошибкой сети"}.`);
    }
    const parsed = parseCodexUsage(json);
    return providerResult({
      id: "codex",
      name,
      plan: parsed.plan,
      account: parsed.account,
      meters: parsed.meters,
    });
  } catch (error) {
    if (error instanceof ProviderError) return providerResult({ id: "codex", name, status: error.status, message: error.message });
    return providerResult({
      id: "codex",
      name,
      status: "error",
      message: error instanceof Error ? error.message : "Codex недоступен",
    });
  }
}
