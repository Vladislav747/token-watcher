import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ProviderError, meter, providerResult, titlePlan, toIso } from "./model.mjs";
import { requestJson, statusError } from "./net.mjs";

const execFileAsync = promisify(execFile);
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const KNOWN_WINDOWS = [
  ["five_hour", "5 часов"],
  ["seven_day", "Неделя"],
  ["seven_day_opus", "Неделя · Opus"],
  ["seven_day_sonnet", "Неделя · Sonnet"],
];

const IGNORED = new Set(["nimbus_quill"]);

export function parseClaudeUsage(body) {
  const raw = typeof body === "string" ? JSON.parse(body) : body;
  if (!raw || typeof raw !== "object") {
    throw new ProviderError("error", "Claude вернул пустой ответ");
  }

  const meters = [];
  const seen = new Set(["extra_usage", "limits"]);

  for (const [key, label] of KNOWN_WINDOWS) {
    seen.add(key);
    const window = raw[key];
    if (!window || window.utilization == null) continue;
    meters.push(
      meter({
        id: key,
        label,
        usedPercent: window.utilization,
        resetsAt: toIso(window.resets_at),
      }),
    );
  }

  const extra = raw.extra_usage;
  if (extra?.is_enabled) {
    const used = extra.used_credits == null ? null : Number(extra.used_credits) / 100;
    const limit = extra.monthly_limit == null ? null : Number(extra.monthly_limit) / 100;
    meters.push(
      meter({
        id: "extra_usage",
        label: "Дополнительно",
        usedPercent: extra.utilization,
        used: Number.isFinite(used) ? used : null,
        limit: Number.isFinite(limit) ? limit : null,
        remaining:
          Number.isFinite(used) && Number.isFinite(limit) ? Math.max(0, limit - used) : null,
        unit: "usd",
        resetsAt: null,
      }),
    );
  }

  if (Array.isArray(raw.limits)) {
    for (const entry of raw.limits) {
      if (!entry || entry.percent == null) continue;
      if (entry.kind === "session" || entry.kind === "weekly_all") continue;
      const modelName = entry.scope?.model?.display_name;
      if (!modelName) continue;
      const slug = modelName.toLowerCase().replace(/\s+/g, "_");
      meters.push(
        meter({
          id: `weekly_${slug}`,
          label: `Неделя · ${modelName}`,
          usedPercent: entry.percent,
          resetsAt: toIso(entry.resets_at),
        }),
      );
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (seen.has(key) || IGNORED.has(key)) continue;
    if (!value || typeof value !== "object" || value.utilization == null) continue;
    meters.push(
      meter({
        id: key,
        label: key,
        usedPercent: value.utilization,
        resetsAt: toIso(value.resets_at),
      }),
    );
  }

  if (meters.length === 0) {
    throw new ProviderError("error", "Claude изменил формат лимитов");
  }
  return meters;
}

async function readKeychain() {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 20_000 },
    );
    return stdout.trim();
  } catch (error) {
    if (error?.killed) {
      throw new ProviderError(
        "error",
        "macOS ждёт разрешение на связку ключей Claude. Разрешите доступ и обновите страницу.",
      );
    }
    return null;
  }
}

async function readCredentialsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    return await readFile(path.join(dir, ".credentials.json"), "utf8");
  } catch {
    return null;
  }
}

function credentialFromJson(text) {
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    plan: titlePlan(oauth.subscriptionType),
  };
}

export async function loadClaudeCredential() {
  const fromKeychain = credentialFromJson(await readKeychain());
  if (fromKeychain) return fromKeychain;
  const fromFile = credentialFromJson(await readCredentialsFile());
  if (fromFile) return fromFile;
  throw new ProviderError(
    "missing",
    "Подписка Claude видна только после входа в Claude Code. Admin API её не отдаёт.",
  );
}

export async function fetchClaude() {
  const name = "Claude";
  try {
    const cred = await loadClaudeCredential();
    const { status, json } = await requestJson(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.69",
        Accept: "application/json",
      },
    });
    if (!json || status >= 400) {
      const kind = statusError(status);
      if (kind === "auth") {
        throw new ProviderError("auth", "Сессия Claude истекла. Войдите в Claude Code ещё раз.");
      }
      if (kind === "rate") {
        throw new ProviderError("error", "Claude просит подождать: слишком частые запросы. Попробуйте войти в Claude Code ещё раз.");
      }
      throw new ProviderError("error", `Claude ответил ${status || "ошибкой сети"}.`);
    }
    return providerResult({
      id: "claude",
      name,
      plan: cred.plan,
      meters: parseClaudeUsage(json),
    });
  } catch (error) {
    if (error instanceof ProviderError) return providerResult({ id: "claude", name, status: error.status, message: error.message });
    return providerResult({
      id: "claude",
      name,
      status: "error",
      message: error instanceof Error ? error.message : "Claude недоступен",
    });
  }
}
