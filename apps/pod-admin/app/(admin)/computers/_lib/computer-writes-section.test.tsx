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

vi.mock("../../../../lib/trpc", async () => {
  const query = (data: unknown) => ({
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => undefined,
  });
  const q = {
    agentUsers: {
      governance: ({ agentUserId }: { agentUserId: string }) =>
        query(reads.gov[agentUserId]),
    },
  };
  return {
    trpc: {
      presence: (
        await import("../../../_lib/presence/__tests__/trpc-double")
      ).presenceTrpcDouble(),
      useUtils: () => ({}),
      useQueries: (fn: (t: typeof q) => unknown[]) => fn(q),
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

const govOf = (
  posture: string | null,
  effective?: { writeMode: string; decidedBy: string }
) => ({
  writeMode: posture ?? "pod-default",
  line: "line",
  askFirst: posture === "ask-first",
  postures: { pod: posture, spaces: [] },
  podDefaultEnabled: true,
  effective: effective
    ? { ...effective, line: "", computer: { id: "pc-1", name: "MacBook" } }
    : null,
});

const agent = (id: string, name: string) => ({
  id,
  agentType: "claude-code",
  name,
  displayName: name,
  lastSeenAt: null,
  key: null,
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

  it("counts the agents this computer holds back, from the pod's effective read", () => {
    reads.gov = {
      "pc-1": govOf("ask-first"),
      cc: govOf(null, { writeMode: "ask-first", decidedBy: "computer" }),
      codex: govOf("ask-first", { writeMode: "ask-first", decidedBy: "agent" }),
    };
    const t = text(
      renderToStaticMarkup(
        <ComputerWrites
          computer={{
            ...MAC,
            agents: [agent("cc", "Claude Code"), agent("codex", "Codex")],
          }}
        />
      )
    );
    expect(t).toContain("1 agent on it asks more because of this computer.");
  });

  it("says nothing about held agents when none is held", () => {
    reads.gov = {
      "pc-1": govOf(null),
      cc: govOf(null, { writeMode: "pod-default", decidedBy: "pod-default" }),
    };
    const t = text(
      renderToStaticMarkup(
        <ComputerWrites
          computer={{ ...MAC, agents: [agent("cc", "Claude Code")] }}
        />
      )
    );
    expect(t).not.toContain("because of this computer");
  });
});
