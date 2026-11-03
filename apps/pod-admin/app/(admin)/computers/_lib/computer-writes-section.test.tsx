/**
 * "What agents on this computer may do", rendered (react-dom/server) with the
 * pod's answers stubbed: the ONE write-mode choice set on the computer, the
 * ceiling sentence, and the rules behind a disclosure.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const reads = vi.hoisted(() => ({
  gov: {} as Record<string, unknown>,
}));

vi.mock("../../../../lib/trpc", () => {
  const query = (data: unknown) => ({
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => undefined,
  });
  return {
    trpc: {
      useUtils: () => ({}),
      agentUsers: {
        governance: {
          useQuery: ({ agentUserId }: { agentUserId: string }) =>
            query(reads.gov[agentUserId]),
        },
        setPosture: {
          useMutation: () => ({
            mutate: () => undefined,
            isPending: false,
            variables: undefined,
          }),
        },
      },
      governanceRules: { listAll: { useQuery: () => query({ rules: [] }) } },
      workspaces: { list: { useQuery: () => query([]) } },
    },
  };
});

import { ComputerWrites } from "./computer-writes-section";
import type { ComputerLike } from "./computer-model";

const MAC: ComputerLike = {
  id: "pc-1",
  name: "MacBook",
  hostname: "mac.local",
  platform: "darwin",
  createdAt: "2026-11-01T20:12:00.000Z",
  lastSeenAt: null,
  key: null,
  keyTtlDays: null,
  effectiveKeyTtlDays: 90,
  minKeyTtlDays: 15,
  maxKeyTtlDays: 3650,
  accessName: null,
  belongsTo: "person",
  agents: [],
};

const govOf = (posture: string | null) => ({
  writeMode: posture ?? "pod-default",
  line: "line",
  askFirst: posture === "ask-first",
  postures: { pod: posture, spaces: [] },
  podDefaultEnabled: true,
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("ComputerWrites", () => {
  it("offers the computer's own mode with the one choice list, and says it is a ceiling", () => {
    reads.gov = { "pc-1": govOf("ask-first") };
    const t = text(renderToStaticMarkup(<ComputerWrites computer={MAC} />));
    expect(t).toContain("What agents on this computer may do");
    // The computer's current mode is shown without opening anything.
    expect(t).toContain("Ask first");
    expect(t).toContain("Normal (recommended)");
    expect(t).toContain(
      "Every agent on MacBook does at most this, whatever its own setting allows."
    );
    // The rules wait behind the disclosure.
    expect(t).toContain("Show the rules");
    expect(t).not.toContain("Pod default");
  });
});
