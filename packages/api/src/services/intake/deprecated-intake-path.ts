/**
 * THE measurement of the Capture → Library deprecation (capture-vs-library
 * decision, stage 2 "Redirected"): every time a PERSON's door still sends a link, a
 * file or a page to Capture, the pod records one `deprecated_intake_path`
 * event naming the registry row (`DEPRECATED_INTAKE_PATHS`) and the caller.
 * The L6 removal criterion is "zero of these from first-party clients for 7
 * days" — without this event, zero would only mean "unmeasured".
 *
 * Never for the agent door: an agent key or the IS internal key keeps sending
 * links and files to capture by design (founder, 2026-10-13).
 *
 * Best effort: a failed record is logged, never fails the capture.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@synap-core/core";
import { isAgentCaller } from "../library/agent-door.js";

const logger = createLogger({ module: "intake/deprecated-intake-path" });

export const DEPRECATED_INTAKE_PATH_EVENT = "deprecated_intake_path" as const;

/** Which registry rows a capture input exercises (pure). */
export function deprecatedCapturePaths(
  door: "structure" | "thought",
  input: { url?: unknown; file?: unknown; html?: unknown }
): string[] {
  if (door === "thought") return input.url ? ["capture.thought.url"] : [];
  return [
    ...(input.url ? ["capture.url"] : []),
    ...(input.file ? ["capture.file"] : []),
    ...(input.html ? ["capture.html"] : []),
  ];
}

export interface DeprecatedIntakeCaller {
  userId: string;
  agentUserId?: string | null;
  keyType?: string | null;
  /** The client that called, when it says (`x-synap-client` / key name). */
  client?: string | null;
}

type Append = (event: {
  id: string;
  version: "v1";
  type: string;
  subjectType: string;
  data: Record<string, unknown>;
  userId: string;
  source: "api";
  timestamp: Date;
}) => Promise<unknown>;

/** Record one event per path a person's door used. Returns the paths recorded. */
export async function recordDeprecatedIntakePaths(
  caller: DeprecatedIntakeCaller,
  pathIds: readonly string[],
  append?: Append
): Promise<string[]> {
  if (pathIds.length === 0 || isAgentCaller(caller)) return [];
  const write =
    append ??
    (async (event) => {
      const { eventRepository } = await import("@synap/database");
      return eventRepository.append(event);
    });
  const recorded: string[] = [];
  for (const pathId of pathIds) {
    try {
      await write({
        id: randomUUID(),
        version: "v1",
        type: DEPRECATED_INTAKE_PATH_EVENT,
        subjectType: "intake",
        data: {
          pathId,
          keyType: caller.keyType ?? "session",
          ...(caller.client ? { client: caller.client } : {}),
        },
        userId: caller.userId,
        source: "api",
        timestamp: new Date(),
      });
      recorded.push(pathId);
    } catch (err) {
      logger.warn(
        { err, pathId, userId: caller.userId },
        "deprecated intake path NOT recorded"
      );
    }
  }
  return recorded;
}
