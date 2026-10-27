const board = document.querySelector("#board");
const updated = document.querySelector("#updated");
const refresh = document.querySelector("#refresh");

const names = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatPercent(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1_000_000) return `${formatPercent(number / 1_000_000)} млн`;
  if (number >= 1_000) return `${formatPercent(number / 1_000)} тыс`;
  return formatPercent(number);
}

function formatMoney(value) {
  if (value == null || Number.isNaN(value)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatReset(iso) {
  if (!iso) return "";
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const delta = target - Date.now();
  if (delta <= 0) return "сброс уже должен был пройти";
  const minutes = Math.round(delta / 60000);
  if (minutes < 60) return `сброс через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `сброс через ${hours} ч ${rest} мин` : `сброс через ${hours} ч`;
  const days = Math.floor(hours / 24);
  const dayHours = hours % 24;
  return dayHours ? `сброс через ${days} д ${dayHours} ч` : `сброс через ${days} д`;
}

function tone(remaining) {
  if (remaining == null) return "";
  if (remaining <= 20) return "bad";
  if (remaining <= 50) return "warn";
  return "";
}

function isPrimary(id) {
  return (
    ["five_hour", "seven_day", "session", "weekly", "plan", "week", "period", "api_balance"].includes(id) ||
    id.startsWith("weekly_")
  );
}

function headline(provider) {
  const percentMeters = provider.meters.filter((item) => item.remainingPercent != null);
  const primary = percentMeters.filter((item) => isPrimary(item.id));
  const pool = primary.length > 0 ? primary : percentMeters;
  if (pool.length === 0) {
    const money = provider.meters.find((item) => item.unit === "usd" && (item.remaining != null || item.used != null));
    if (money?.remaining != null) return { value: formatMoney(money.remaining), caption: "осталось по бюджету" };
    if (money?.used != null) return { value: formatMoney(money.used), caption: money.label.toLowerCase() };
    const credit = provider.meters.find((item) => item.unit === "credits" && (item.remaining != null || item.used != null));
    if (credit) return { value: formatCount(credit.remaining ?? credit.used), caption: "токенов" };
    return { value: "—", caption: provider.message || "нет шкалы" };
  }
  const tightest = pool.reduce((a, b) => (a.remainingPercent <= b.remainingPercent ? a : b));
  if (tightest.id === "api_balance" && tightest.remaining != null) {
    return { value: formatMoney(tightest.remaining), caption: "осталось" };
  }
  return {
    value: `${formatPercent(tightest.remainingPercent)}%`,
    caption: `осталось · ${tightest.label.toLowerCase()}`,
  };
}

function meterRow(item) {
  if (item.usedPercent == null) {
    if (item.unit === "credits" && (item.remaining != null || item.used != null)) {
      const value = item.remaining ?? item.used;
      return `<div class="meter"><div class="meter-top"><span>${escapeHtml(item.label)}</span><span>${escapeHtml(formatCount(value))}</span></div></div>`;
    }
    if (item.unit === "usd" && (item.used != null || item.remaining != null)) {
      const left = formatMoney(item.remaining);
      const spent = formatMoney(item.used);
      return `<div class="meter"><div class="meter-top"><span>${escapeHtml(item.label)}</span><span>${left ? `${left} осталось` : spent || ""}</span></div></div>`;
    }
    return `<div class="meter"><div class="meter-top"><span>${escapeHtml(item.label)}</span><span>без шкалы</span></div></div>`;
  }

  const remaining = item.remainingPercent;
  const limit = item.unit === "usd" ? formatMoney(item.limit) : null;
  const reset = formatReset(item.resetsAt);
  return `
    <div class="meter">
      <div class="meter-top">
        <span>${escapeHtml(item.label)}</span>
        <span>${item.unit === "usd" && item.remaining != null ? formatMoney(item.remaining) : `осталось ${formatPercent(remaining)}%`}</span>
      </div>
      <div class="track"><div class="fill ${tone(remaining)}" style="width:${Math.max(0, Math.min(100, remaining))}%"></div></div>
      <div class="meter-meta">
        <span>${limit ? `из ${limit}` : `израсходовано ${formatPercent(item.usedPercent)}%`}</span>
        <span>${escapeHtml(reset)}</span>
      </div>
    </div>`;
}

function card(provider) {
  const head = headline(provider);
  const plan = [provider.plan, provider.account].filter(Boolean).join(" · ");
  const body = provider.status === "ok"
    ? `<div class="headline"><strong>${escapeHtml(head.value)}</strong><span>${escapeHtml(head.caption)}</span></div>
       <div class="meters">${provider.meters.map(meterRow).join("")}</div>
       ${provider.notice ? `<p class="notice">${escapeHtml(provider.notice)}</p>` : ""}`
    : `<p class="note">${escapeHtml(provider.message || "Нет данных")}</p>`;
  return `
    <article class="card" data-id="${escapeHtml(provider.id)}">
      <div class="card-head">
        <h2>${escapeHtml(provider.name || names[provider.id] || provider.id)}</h2>
        <span class="plan">${escapeHtml(plan)}</span>
      </div>
      ${body}
    </article>`;
}

function render(data) {
  const byId = new Map(data.providers.map((item) => [item.id, item]));
  const ordered = ["claude", "codex", "cursor"].map((id) => byId.get(id)).filter(Boolean);
  board.innerHTML = ordered.map(card).join("");
  const when = new Date(data.fetchedAt);
  updated.textContent = `обновлено ${when.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
}

async function load() {
  refresh.disabled = true;
  try {
    const response = await fetch("/api/usage", { cache: "no-store" });
    if (!response.ok) throw new Error("Сервер не отдал лимиты");
    render(await response.json());
  } catch (error) {
    board.innerHTML = `<article class="card"><p class="note">${escapeHtml(error.message)}</p></article>`;
    updated.textContent = "не удалось обновить";
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", load);
load();
setInterval(load, 60_000);
