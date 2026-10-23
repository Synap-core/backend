/**
 * The heartbeat codec is the never-stored floor of the terminal registry
 * (0354): what a reporter sends either becomes one of the columns the store
 * accepts, reduced, or is refused before anything is written.
 *
 * Pinned:
 *   - every field the plan forbids (prompt text, pid, tty, resume paths,
 *     tokens, account labels) and any identity field (userId, agentUserId,
 *     apiKeyId — those come from the KEY) is REFUSED, not dropped quietly;
 *   - `folder` keeps only its basename; a path never reaches the output;
 *   - `computer` is one normalised host-name label, so two spellings of one
 *     computer are one key;
 *   - `conversationId` / `harness` refuse a path;
 *   - the decoded value has EXACTLY the store's reporter-controlled keys
 *     (a new field must be classified here to pass).
 *
 * Not covered, by design: a secret placed INSIDE an allowed field (shape,
 * not intent — see the codec's header).
 */
import { describe, it, expect } from "vitest";
import {
  decodeHeartbeat,
  folderBasename,
  normalizeComputerName,
  type DecodedHeartbeat,
} from "../heartbeat-codec.js";

const BASE = {
  computer: "Ada-MacBook-Pro.local",
  harness: "claude-code",
  conversationId: "6f1c2a4e-9b7d-4a51-8c3e-2d9f0b1a7c55",
  state: "working",
};

describe("heartbeat codec — never stored", () => {
  const FORBIDDEN: Record<string, unknown> = {
    prompt: "fix the login bug in auth.ts",
    promptText: "…",
    lastPrompt: "…",
    pid: 4242,
    tty: "/dev/ttys004",
    resumePath: "/Users/ada/.claude/projects/x/6f1c.jsonl",
    transcriptPath: "/Users/ada/.claude/projects/x/6f1c.jsonl",
    token: "sk-live-xyz",
    apiKey: "synap_hub_xyz",
    accountLabel: "ada@work",
    account: "ada@work",
    cwd: "/Users/ada/code/synap",
    // Identity is the KEY's, never the body's.
    userId: "someone-else",
    agentUserId: "agent-x",
    apiKeyId: "00000000-0000-0000-0000-000000000000",
  };

  for (const [field, value] of Object.entries(FORBIDDEN)) {
    it(`refuses \`${field}\` (400, nothing decoded)`, () => {
      const r = decodeHeartbeat({ ...BASE, [field]: value });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/unrecognized/i);
    });
  }

  it("a clean body decodes (non-vacuity of the refusals above)", () => {
    expect(decodeHeartbeat(BASE).ok).toBe(true);
  });

  it("folder: only its basename survives — the path is never in the output", () => {
    const r = decodeHeartbeat({
      ...BASE,
      folder: "/Users/ada/code/synap-backend/",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.heartbeat.folder).toBe("synap-backend");
    expect(JSON.stringify(r.heartbeat)).not.toContain("/Users");
    expect(folderBasename("C:\\Users\\ada\\work\\site")).toBe("site");
    expect(folderBasename("synap")).toBe("synap");
    expect(folderBasename("/")).toBeNull();
    expect(folderBasename("~")).toBeNull();
    expect(folderBasename(undefined)).toBeNull();
  });

  it("computer: one normalised host-name label (two spellings, one key)", () => {
    expect(normalizeComputerName("Ada-MacBook-Pro.local")).toBe(
      "ada-macbook-pro"
    );
    expect(normalizeComputerName("ada-macbook-pro")).toBe("ada-macbook-pro");
    expect(normalizeComputerName("  devbox  ")).toBe("devbox");
    expect(normalizeComputerName("Ada's MacBook")).toBe("ada-s-macbook");
    expect(normalizeComputerName("/Users/ada")).toBe("users-ada");
    expect(normalizeComputerName("...")).toBeNull();
    const r = decodeHeartbeat(BASE);
    expect(r.ok && r.heartbeat.computer).toBe("ada-macbook-pro");
  });

  it("conversationId and harness refuse a path", () => {
    expect(
      decodeHeartbeat({ ...BASE, conversationId: "/Users/ada/.claude/x.jsonl" })
        .ok
    ).toBe(false);
    expect(decodeHeartbeat({ ...BASE, harness: "../claude" }).ok).toBe(false);
  });

  it("state is the closed set; sessionId must be a uuid", () => {
    expect(decodeHeartbeat({ ...BASE, state: "thinking" }).ok).toBe(false);
    expect(decodeHeartbeat({ ...BASE, sessionId: "not-a-uuid" }).ok).toBe(
      false
    );
  });

  it("the decoded value carries exactly the store's reporter-controlled keys", () => {
    const r = decodeHeartbeat({
      ...BASE,
      folder: "synap",
      subagents: 2,
      sessionId: "11111111-1111-4111-8111-111111111111",
      ended: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const keys: Array<keyof DecodedHeartbeat> = [
      "computer",
      "harness",
      "conversationId",
      "state",
      "folder",
      "subagentCount",
      "sessionId",
      "ended",
    ];
    expect(Object.keys(r.heartbeat).sort()).toEqual([...keys].sort());
    expect(r.heartbeat.subagentCount).toBe(2);
  });
});
