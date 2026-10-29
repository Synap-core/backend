/**
 * Embeddings through the IS (`/api/embeddings`, `/api/embeddings/batch`) — the
 * one door the embedding workers use, so per-customer provider config and
 * metering stay on the IS side.
 */

import { resolveDefaultIntelligenceEndpoint } from "@synap/database";

/** The IS refuses a batch above this (`embeddings-router.ts`). */
export const EMBEDDINGS_BATCH_MAX = 100;

async function postEmbeddings(path: string, body: unknown): Promise<unknown> {
  const { endpoint, apiKey } = await resolveDefaultIntelligenceEndpoint();
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `Failed to generate embedding: HTTP ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`
    );
  }
  return response.json();
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const data = await postEmbeddings("/api/embeddings", { text });
  return (data as { embedding: number[] }).embedding;
}

/**
 * One vector per text, in order, in calls of ≤ {@link EMBEDDINGS_BATCH_MAX}.
 * `model` = the model the IS reports. A short answer throws: a vector must
 * never land on the wrong text.
 */
export async function generateEmbeddings(
  texts: string[]
): Promise<{ embeddings: number[][]; model: string | undefined }> {
  const embeddings: number[][] = [];
  let model: string | undefined;
  for (let i = 0; i < texts.length; i += EMBEDDINGS_BATCH_MAX) {
    const chunk = texts.slice(i, i + EMBEDDINGS_BATCH_MAX);
    const data = (await postEmbeddings("/api/embeddings/batch", {
      texts: chunk,
    })) as { embeddings?: number[][]; model?: unknown };
    if (
      !Array.isArray(data.embeddings) ||
      data.embeddings.length !== chunk.length
    ) {
      throw new Error(
        `Embedding batch returned ${Array.isArray(data.embeddings) ? data.embeddings.length : "no"} vectors for ${chunk.length} texts`
      );
    }
    embeddings.push(...data.embeddings);
    if (typeof data.model === "string") model = data.model;
  }
  return { embeddings, model };
}
