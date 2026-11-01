/**
 * The large-approval lines, rendered (react-dom/server; pod-admin's vitest
 * runs in node): what the toast and the review's decision bar draw from one
 * copy. A failed read keeps a bar AND offers Retry; a stopped run draws no
 * bar (it is not moving) but says why.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";

vi.mock("../../../lib/trpc", () => ({ trpc: {} }));

import { ApprovalProgressLines } from "./approval-progress-toast";
import {
  approvalProgressCopy,
  progressUnavailable,
  type ApprovalRun,
} from "./approval-progress-model";

const RUN: ApprovalRun = {
  runId: "r1",
  proposalId: "p1",
  state: "running",
  phase: "relations",
  total: 4222,
  done: 3100,
  created: 3050,
  linked: 50,
  failed: 0,
  error: null,
  primaryId: null,
  sessionId: null,
  relationsFailed: 0,
};

describe("ApprovalProgressLines", () => {
  it("running: a determinate bar and the counts", () => {
    const html = render(
      <ApprovalProgressLines copy={approvalProgressCopy(RUN)} />
    );
    expect(html).toContain('aria-valuenow="73"');
    expect(html).toContain("3,050 created · 50 already there");
    expect(html).not.toContain("<button");
  });

  it("a failed read: still a bar (it may be running) and Retry", () => {
    const html = render(
      <ApprovalProgressLines copy={progressUnavailable()} onRetry={() => {}} />
    );
    expect(html).toContain('role="progressbar"');
    // The BUTTON, not the word: the detail sentence says "Check again"
    // (a text match stayed green with the button removed — negctl 2026-10-23).
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Try again/);
  });

  it("stopped: no bar, the reason", () => {
    const html = render(
      <ApprovalProgressLines
        copy={approvalProgressCopy({
          ...RUN,
          state: "failed",
          error: "The approval could not be started.",
        })}
      />
    );
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain("could not be started");
  });
});
