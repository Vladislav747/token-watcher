import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeUsage } from "../src/claude.mjs";
import { parseCodexUsage } from "../src/codex.mjs";
import { isWeeklyPlan, jwtSubject, mergeCursor, sessionCookie } from "../src/cursor.mjs";

test("Claude читает окна и отдельный лимит модели", () => {
  const meters = parseClaudeUsage({
    five_hour: { utilization: 12.5, resets_at: "2026-10-26T12:00:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-11-01T00:00:00Z" },
    seven_day_sonnet: null,
    limits: [
      { kind: "session", percent: 12.5, resets_at: "2026-10-26T12:00:00Z" },
      {
        kind: "weekly_scoped",
        percent: 7,
        resets_at: "2026-11-01T00:00:00Z",
        scope: { model: { display_name: "Fable" } },
      },
    ],
  });

  assert.equal(meters.find((item) => item.id === "five_hour").remainingPercent, 87.5);
  assert.equal(meters.find((item) => item.id === "seven_day").usedPercent, 40);
  assert.equal(meters.find((item) => item.id === "weekly_fable").label, "Неделя · Fable");
  assert.equal(meters.some((item) => item.id === "session"), false);
});

test("Codex отличает пятичасовое окно от недели по длительности", () => {
  const parsed = parseCodexUsage({
    plan_type: "pro",
    email: "dev@example.com",
    rate_limit: {
      primary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: 1760000000 },
      secondary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1760001000 },
    },
    credits: { balance: "0" },
  });

  assert.equal(parsed.plan, "Pro 20x");
  assert.equal(parsed.meters[0].label, "Неделя");
  assert.equal(parsed.meters[0].remainingPercent, 20);
  assert.equal(parsed.meters[1].label, "5 часов");
});

test("Cursor на недельном плане берёт процент периода, а не нули сводки", () => {
  const merged = mergeCursor({
    summary: {
      membershipType: "premium",
      billingCycleEnd: "2026-11-02T00:00:00.000Z",
      individualUsage: {
        plan: { totalPercentUsed: 0, autoPercentUsed: 0, apiPercentUsed: 0, limit: 0, used: 0 },
        onDemand: { enabled: false },
      },
    },
    planInfo: { planInfo: { includedUsagePeriod: "INCLUDED_USAGE_PERIOD_WEEKLY", includedUsageResetsAt: "1762000000000" } },
    period: { planUsage: { totalPercentUsed: 35.5 }, billingCycleEnd: "1762000000000" },
  });

  assert.equal(isWeeklyPlan({ planInfo: { includedUsagePeriod: 2 } }), true);
  assert.equal(merged.plan, "Premium");
  assert.equal(merged.meters[0].label, "Неделя");
  assert.equal(merged.meters[0].usedPercent, 35.5);
  assert.equal(merged.meters[0].remainingPercent, 64.5);
});

test("cookie Cursor собирается из sub токена и не логирует лишнее", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "auth0|user_123" })).toString("base64url");
  const token = `aaa.${payload}.sig`;
  assert.equal(jwtSubject(token), "auth0|user_123");
  assert.equal(
    sessionCookie(token),
    `WorkosCursorSessionToken=auth0%7Cuser_123%3A%3A${token}`,
  );
  assert.equal(
    sessionCookie(token, { idOnly: true }),
    `WorkosCursorSessionToken=user_123%3A%3A${token}`,
  );
});
