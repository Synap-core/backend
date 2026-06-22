/**
 * synthesizeAnswer — shared retrieve→synthesize pipeline used by BOTH:
 *   - POST /knowledge/answer  (hub-protocol REST handler)
 *   - synap_ask MCP tool      (MCP adapter)
 *
 * Takes the raw `AskResult.answers` blocks, builds a compact context string,
 * calls the IS `/api/knowledge/answer` synthesis endpoint, and returns a
 * uniform result object. Falls back gracefully when the IS is unavailable.
 *
 * Callers own the HTTP response layer (c.json / return ok) — this function
 * returns a plain object so behaviour at both call sites stays byte-identical.
 */

import type { AskAnswer } from "./ask.js";

export interface SynthesisSource {
  substrate: string;
  id: string;
  title: string;
}

export interface SynthesisResult {
  answer: string | null;
  sources: SynthesisSource[];
  /** Which substrates were queried (forwarded from AskResult). */
  routedTo: string[];
  /** Present only on IS unavailability — callers surface sources instead. */
  error?: "synthesis_unavailable";
}

const MAX_CONTEXT_CHARS = 16_000;

/**
 * Build context + sources from retrieved answer blocks, then call the IS
 * synthesis endpoint. Returns a SynthesisResult regardless of IS availability.
 */
export async function synthesizeAnswer(
  answers: AskAnswer[],
  question: string,
  routedTo: string[],
  workspaceId: string | null | undefined
): Promise<SynthesisResult> {
  const sources: SynthesisSource[] = [];
  const contextParts: string[] = [];
  let contextLen = 0;

  for (const block of answers) {
    if (block.status !== "ok") continue;
    for (const item of block.items) {
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      const title =
        (typeof rec.name === "string" && rec.name) ||
        (typeof rec.title === "string" && rec.title) ||
        (typeof rec.claim === "string" && rec.claim) ||
        (typeof rec.fact === "string" && rec.fact) ||
        (typeof rec.content === "string" && rec.content) ||
        id ||
        "(item)";

      if (id) sources.push({ substrate: block.substrate, id, title });

      // Short snippet: title + a few key string props.
      const snippetBits: string[] = [String(title)];
      for (const [k, v] of Object.entries(rec)) {
        if (k === "id" || k === "name" || k === "title") continue;
        if (typeof v === "string" && v.trim()) {
          snippetBits.push(`${k}: ${v.slice(0, 300)}`);
        }
        if (snippetBits.length >= 5) break;
      }
      const entry = `- [${block.substrate}] ${snippetBits.join(" · ")}`;
      if (contextLen + entry.length > MAX_CONTEXT_CHARS) break;
      contextParts.push(entry);
      contextLen += entry.length + 1;
    }
    if (contextLen >= MAX_CONTEXT_CHARS) break;
  }

  const context = contextParts.join("\n");

  // Call the IS "answer" door — one focused LLM call.
  const isUrl = process.env.INTELLIGENCE_HUB_URL || "http://localhost:3002";
  try {
    const res = await fetch(`${isUrl}/api/knowledge/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": process.env.INTELLIGENCE_HUB_INTERNAL_KEY ?? "",
      },
      body: JSON.stringify({
        question,
        context,
        workspaceId: workspaceId ?? undefined,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`IS answer HTTP ${res.status}`);
    const data = (await res.json()) as { answer?: string };
    return {
      answer: typeof data.answer === "string" ? data.answer : null,
      sources,
      routedTo,
    };
  } catch {
    // Synthesis unavailable — return sources so callers can still show matches.
    return {
      answer: null,
      sources,
      routedTo,
      error: "synthesis_unavailable",
    };
  }
}
