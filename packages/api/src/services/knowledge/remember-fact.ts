/**
 * rememberFact — shared service behind the MCP `synap_remember_fact` tool.
 *
 * Embeds the fact through the SAME path entity/recall writes use
 * (`@synap/ai-embeddings`) so semantic search can rank it, then persists via
 * `knowledgeRepository.saveFact`. Best-effort embedding: if unavailable it
 * falls back to a zero vector (keyword search still works) rather than failing
 * the write. Extracted from the MCP adapter so the tool handler just delegates.
 */

import { knowledgeRepository } from "@synap/database";
import type { KnowledgeFactRecord } from "@synap/database";

export async function rememberFact(params: {
  userId: string;
  fact: string;
  confidence?: number;
}): Promise<KnowledgeFactRecord> {
  const { userId, fact } = params;

  let embedding: number[];
  try {
    const { generateEmbedding } = await import("@synap/ai-embeddings");
    embedding = await generateEmbedding(fact);
  } catch {
    embedding = new Array(1536).fill(0);
  }

  return knowledgeRepository.saveFact({
    userId,
    fact,
    confidence: params.confidence ?? 0.8,
    embedding,
  });
}
