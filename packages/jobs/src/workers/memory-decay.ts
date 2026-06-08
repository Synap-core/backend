/**
 * Memory Decay Worker
 *
 * Applies Ebbinghaus forgetting-curve decay to all knowledge_facts rows.
 *
 * Formula: R = GREATEST(0.05, EXP(-t / S))
 *   t = days elapsed since last access (falls back to created_at)
 *   S = 1 + (access_count * 0.5)  — stability grows with each recall
 *
 * A fact recalled often decays much more slowly than one never recalled.
 * The floor of 0.05 prevents complete erasure — facts are ranked lower,
 * not forgotten entirely.
 *
 * Scheduled daily at 03:30 UTC via cron.ts.
 */

import { sql } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "memory-decay" });

export const MEMORY_DECAY_QUEUE = "memory-decay";

export async function handleMemoryDecay(): Promise<void> {
  logger.info("memory-decay: applying Ebbinghaus decay to knowledge_facts");

  const result = await sql`
    UPDATE knowledge_facts
    SET relevance_score = GREATEST(
      0.05,
      EXP(
        -EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed_at, created_at))) / 86400.0
        / (1.0 + access_count * 0.5)
      )
    )
    WHERE last_accessed_at IS NOT NULL
       OR created_at < NOW() - INTERVAL '1 day'
  `;

  const updated = result.count ?? 0;
  logger.info({ updated }, "memory-decay: decay scores updated");
}
