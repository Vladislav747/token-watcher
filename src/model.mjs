export class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

export function meter({
  id,
  label,
  usedPercent = null,
  used = null,
  limit = null,
  remaining = null,
  unit = "percent",
  resetsAt = null,
}) {
  const usedPct = usedPercent == null ? null : clampPercent(usedPercent);
  return {
    id,
    label,
    usedPercent: usedPct,
    remainingPercent: usedPct == null ? null : Math.max(0, 100 - usedPct),
    used,
    limit,
    remaining,
    unit,
    resetsAt,
  };
}

export function providerResult({
  id,
  name,
  status = "ok",
  message = null,
  plan = null,
  account = null,
  meters = [],
  notice = null,
}) {
  return {
    id,
    name,
    status,
    message,
    plan,
    account,
    meters,
    notice,
    fetchedAt: new Date().toISOString(),
  };
}

export function fail(id, name, error) {
  const status = error instanceof ProviderError ? error.status : "error";
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  return providerResult({ id, name, status, message, meters: [] });
}

export function centsToUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

export function toIso(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const ms = n < 1e12 ? n * 1000 : n;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function titlePlan(value, map = {}) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  if (map[key]) return map[key];
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
