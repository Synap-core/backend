/**
 * The ONE external-agent view. Rows are the inputs where candidate rules
 * DISAGREE: cancelled (worded as Done vs Cancelled), an unknown status (a
 * guess vs unmeasured), needs_input (working vs your turn), a parked run
 * (`waiting_on_you` — cancellable or not), and an unsafe link (door or none).
 */
import { describe, expect, it } from "vitest";
import { resolveExternalAgentView, safeExternalUrl } from "./index.js";

const base = {
  runStatus: "running",
  provider: "github",
  status: "running",
  url: "https://github.com/acme/app/issues/7",
};

describe("resolveExternalAgentView", () => {
  it("running is the live working mark, with the ONE provider door", () => {
    const v = resolveExternalAgentView(base);
    expect(v.mark).toMatchObject({
      state: "working",
      tone: "ai",
      glyph: "spark",
    });
    expect(v.url).toBe("https://github.com/acme/app/issues/7");
    expect(v.openLabel).toBe("Open in GitHub");
    expect(v.cancellable).toBe(true);
  });

  it("needs_input is the person's turn, not working", () => {
    expect(
      resolveExternalAgentView({ ...base, status: "needs_input" }).mark.state
    ).toBe("needs_you");
  });

  it("cancelled is terminal but worded Cancelled, never Done", () => {
    const v = resolveExternalAgentView({
      ...base,
      status: "cancelled",
      runStatus: "cancelled",
    });
    expect(v.mark.state).toBe("done");
    expect(v.label).toBe("Cancelled");
    expect(resolveExternalAgentView({ ...base, status: "done" }).label).toBe(
      "Done"
    );
  });

  it("failed is the failed mark", () => {
    expect(
      resolveExternalAgentView({ ...base, status: "failed" }).mark
    ).toMatchObject({
      state: "failed",
      tone: "error",
    });
  });

  it("an unknown status is unmeasured — never guessed as working", () => {
    expect(
      resolveExternalAgentView({ ...base, status: "teleporting" }).mark.state
    ).toBe("unmeasured");
  });

  it("cancel is offered only while the RUN is live (a parked run included)", () => {
    expect(
      resolveExternalAgentView({ ...base, runStatus: "waiting_on_you" })
        .cancellable
    ).toBe(true);
    expect(
      resolveExternalAgentView({ ...base, runStatus: "completed" }).cancellable
    ).toBe(false);
    expect(
      resolveExternalAgentView({ ...base, runStatus: "failed" }).cancellable
    ).toBe(false);
  });

  it("outputs: PR (numbered), branch (plain, no door), preview (host)", () => {
    const v = resolveExternalAgentView({
      ...base,
      prUrl: "https://github.com/acme/app/pull/42",
      branch: " fix/pick ",
      previewUrl: "https://pr-42.preview.acme.dev/x",
    });
    expect(v.outputs).toEqual([
      {
        key: "pull_request",
        noun: "Pull request",
        title: "#42",
        url: "https://github.com/acme/app/pull/42",
        producedAt: null,
      },
      {
        key: "branch",
        noun: "Branch",
        title: "fix/pick",
        url: null,
        producedAt: null,
      },
      {
        key: "preview",
        noun: "Preview",
        title: "pr-42.preview.acme.dev",
        url: "https://pr-42.preview.acme.dev/x",
        producedAt: null,
      },
    ]);
  });

  it("an unsafe link is never a door", () => {
    const v = resolveExternalAgentView({
      ...base,
      url: "javascript:alert(1)",
      prUrl: "file:///etc/passwd",
      previewUrl: "http://plain.example",
    });
    expect(v.url).toBeNull();
    expect(v.outputs).toEqual([]);
    expect(safeExternalUrl("  https://ok.example/a ")).toBe(
      "https://ok.example/a"
    );
  });

  it("the provider door is prominent only when the agent waits on the person", () => {
    // Rows where "prominent when live" and "prominent when needs you" disagree.
    expect(
      resolveExternalAgentView({ ...base, status: "needs_input" }).openProminent
    ).toBe(true);
    expect(resolveExternalAgentView(base).openProminent).toBe(false);
    expect(
      resolveExternalAgentView({ ...base, status: "failed" }).openProminent
    ).toBe(false);
    expect(
      resolveExternalAgentView({ ...base, status: "teleporting" }).openProminent
    ).toBe(false);
  });

  it("the summary starts open only when the task failed", () => {
    expect(
      resolveExternalAgentView({ ...base, status: "failed" }).summaryOpen
    ).toBe(true);
    expect(
      resolveExternalAgentView({ ...base, status: "done" }).summaryOpen
    ).toBe(false);
    expect(
      resolveExternalAgentView({ ...base, status: "cancelled" }).summaryOpen
    ).toBe(false);
    expect(
      resolveExternalAgentView({ ...base, status: "needs_input" }).summaryOpen
    ).toBe(false);
  });

  it("summary is trimmed; blank is none", () => {
    expect(
      resolveExternalAgentView({ ...base, summary: "  Fixed it.  " }).summary
    ).toBe("Fixed it.");
    expect(
      resolveExternalAgentView({ ...base, summary: "   " }).summary
    ).toBeNull();
  });

  it("the section is titled by the AGENT's name, with a door to its page; the provider is the fallback", () => {
    const v = resolveExternalAgentView({
      ...base,
      agentUserId: "agent-1",
      agentName: "  Builder  ",
    });
    expect(v.title).toBe("Builder");
    expect(v.agentDoor).toEqual({ kind: "agent", id: "agent-1" });
    const bare = resolveExternalAgentView({ ...base, agentName: "  " });
    expect(bare.title).toBe("GitHub");
    expect(bare.agentDoor).toBeNull();
  });

  it("3+ failed reads in a row on a LIVE task ⇒ the unreadable mark, worded by the service; fewer, or a settled task, keep their state", () => {
    const at = { firstSeenAt: "2026-10-08T00:00:00.000Z" };
    const down = resolveExternalAgentView({
      ...base,
      pollError: { ...at, count: 3 },
    });
    expect(down.mark.state).toBe("unmeasured");
    expect(down.label).toBe("Can't reach GitHub");
    expect(down.unreachable).toBe(true);
    // The open door is kept.
    expect(down.url).toBe("https://github.com/acme/app/issues/7");
    expect(
      resolveExternalAgentView({ ...base, pollError: { ...at, count: 2 } }).mark
        .state
    ).toBe("working");
    expect(
      resolveExternalAgentView({
        ...base,
        status: "needs_input",
        pollError: { ...at, count: 5 },
      }).mark.state
    ).toBe("unmeasured");
    const done = resolveExternalAgentView({
      ...base,
      status: "done",
      pollError: { ...at, count: 9 },
    });
    expect(done.mark.state).toBe("done");
    expect(done.unreachable).toBe(false);
  });

  it("pending_start is the person's turn with the PROPOSAL as the door; no cancel, the provider door stays secondary", () => {
    const v = resolveExternalAgentView({
      ...base,
      runStatus: "proposed",
      status: "pending_start",
      proposalId: "prop-1",
      url: null,
    });
    expect(v.mark.state).toBe("needs_you");
    expect(v.label).toBe("Needs you");
    expect(v.proposalDoor).toEqual({ kind: "proposal", id: "prop-1" });
    expect(v.cancellable).toBe(false);
    expect(v.openProminent).toBe(false);
    // Even if the run row were live, a pending start offers no cancel.
    expect(
      resolveExternalAgentView({
        ...base,
        status: "pending_start",
        proposalId: "prop-1",
      }).cancellable
    ).toBe(false);
    // A proposal id on any other state is not a door.
    expect(
      resolveExternalAgentView({ ...base, proposalId: "prop-1" }).proposalDoor
    ).toBeNull();
  });

  it("cancel wording is honest: a binding that cannot stop the agent says the run ends in Synap and the agent may keep going", () => {
    const stops = resolveExternalAgentView({ ...base, cancelStopsAgent: true });
    expect(stops.cancelStopsAgent).toBe(true);
    expect(stops.cancelConfirm.description).toBe(
      "GitHub stops working on it, and this run ends."
    );
    for (const cancelStopsAgent of [false, null, undefined]) {
      const v = resolveExternalAgentView({ ...base, cancelStopsAgent });
      expect(v.cancelStopsAgent).toBe(false);
      expect(v.cancelConfirm.description).toMatch(/ends the run in Synap/);
      expect(v.cancelConfirm.description).toMatch(/may keep going/);
      expect(v.cancelConfirm.description).not.toMatch(/stops working/);
    }
  });

  it("an output's producedAt is when the agent first reported it, per output", () => {
    const v = resolveExternalAgentView({
      ...base,
      prUrl: "https://github.com/acme/app/pull/42",
      branch: "fix/pick",
      reportedAt: { pull_request: "2026-10-08T01:00:00.000Z" },
    });
    expect(v.outputs.map((o) => [o.key, o.producedAt])).toEqual([
      ["pull_request", "2026-10-08T01:00:00.000Z"],
      ["branch", null],
    ]);
  });
});
