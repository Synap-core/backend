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
      },
      { key: "branch", noun: "Branch", title: "fix/pick", url: null },
      {
        key: "preview",
        noun: "Preview",
        title: "pr-42.preview.acme.dev",
        url: "https://pr-42.preview.acme.dev/x",
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

  it("summary is trimmed; blank is none", () => {
    expect(
      resolveExternalAgentView({ ...base, summary: "  Fixed it.  " }).summary
    ).toBe("Fixed it.");
    expect(
      resolveExternalAgentView({ ...base, summary: "   " }).summary
    ).toBeNull();
  });
});
