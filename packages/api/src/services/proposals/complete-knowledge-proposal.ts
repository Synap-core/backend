import { completeKnowledgeProperties } from "@synap/database";

/**
 * Completes a historic Knowledge proposal at its governed approval boundary.
 *
 * New direct writes remain strictly validated by the entity repository. This
 * narrowly handles saved proposals created before `knowledgeForm` became
 * required, while retaining an explicit value or a legacy `ek_type` exactly as
 * proposed.
 */
export function completeKnowledgeProposalProperties(input: {
  profileSlug: string;
  properties: Record<string, unknown> | undefined;
  title?: unknown;
  description?: unknown;
  content?: unknown;
}): Record<string, unknown> | undefined {
  if (input.profileSlug !== "knowledge") return input.properties;

  const text = [input.title, input.description, input.content]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return completeKnowledgeProperties(input.properties ?? {}, text);
}
