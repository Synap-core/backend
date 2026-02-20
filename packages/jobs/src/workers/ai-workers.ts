/**
 * AI Analysis Worker
 *
 * Handles AI-powered thought analysis.
 * Ported from Inngest function: ai-analyzer.ts
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "ai-workers" });

export async function handleAiAnalysis(
  job: PgBoss.Job<{
    thoughtId: string;
    content: string;
    userId: string;
  }>
): Promise<void> {
  // Placeholder — the AI analyzer logic uses the Anthropic SDK
  // and is complex. For now, keep it as a passthrough.
  // The original ai-analyzer.ts can be imported directly if needed.
  logger.info({ thoughtId: job.data.thoughtId }, "AI analysis job received (placeholder)");
}
