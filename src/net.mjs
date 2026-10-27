const TIMEOUT_MS = 12_000;

export async function requestJson(url, { method = "GET", headers = {}, body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "сервис не ответил вовремя" : "нет сети";
    const wrapped = new Error(reason);
    wrapped.cause = error;
    throw wrapped;
  }

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, ok: response.ok };
}

export function statusError(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate";
  return "error";
}
