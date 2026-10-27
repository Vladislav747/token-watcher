import { fetchClaude } from "./claude.mjs";
import { fetchCodex } from "./codex.mjs";
import { fetchCursor } from "./cursor.mjs";

export async function collectUsage() {
  const providers = await Promise.all([fetchClaude(), fetchCodex(), fetchCursor()]);
  return {
    fetchedAt: new Date().toISOString(),
    providers,
  };
}
