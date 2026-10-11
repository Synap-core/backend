/**
 * Every `/device` state, rendered (react-dom/server — pod-admin's vitest runs
 * in node, no DOM). Asserts what the reader SEES, so a state that renders the
 * wrong view, or a view that drops its way out, fails here.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { ReactElement } from "react";
import { Card } from "@heroui/react";
import {
  ApprovedView,
  DeniedView,
  EnterCodeView,
  FailedView,
  GoneView,
  LockedView,
  PendingView,
  type PendingViewProps,
} from "./DeviceViews";
import type { DeviceRequest } from "./device-model";
import { sendDecision } from "./DeviceFlow";
import { denyDecision } from "./device-model";

/** Views render inside ReceiverShell's Card, as on the page. */
const renderToStaticMarkup = (el: ReactElement) => render(<Card>{el}</Card>);

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {} }) }));

const REQUEST: DeviceRequest = {
  requestId: "11111111-1111-4111-8111-111111111111",
  status: "pending",
  clientName: "synap-cli",
  hostname: "devbox",
  platform: "linux",
  agents: [
    {
      agentType: "claude-code",
      name: "Claude Code",
      displayName: "Claude Code on devbox",
    },
  ],
  requesterIp: "203.0.113.7",
  userAgent: "synap-cli/1",
  createdAt: "2026-10-11T10:00:00.000Z",
  expiresAt: "2026-10-11T10:10:00.000Z",
  reusableComputers: [],
  keyTtlDays: 90,
  accessName: "AI — read & propose",
};

const noop = () => {};
const pending = (over: Partial<PendingViewProps> = {}) =>
  renderToStaticMarkup(
    <PendingView
      request={REQUEST}
      code="abcdefgh"
      reuseId={null}
      onReuse={noop}
      computerName="devbox"
      onComputerName={noop}
      agents={["claude-code"]}
      onAgents={noop}
      busy={null}
      error={null}
      onApprove={noop}
      onDeny={noop}
      ago={() => "2m ago"}
      {...over}
    />
  );

/** Visible text only — attributes and tags stripped. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("pending", () => {
  it("shows the code to compare, the computer, its agents, access and both actions", () => {
    const t = text(pending());
    expect(t).toContain("Check your terminal shows");
    expect(t).toContain("ABCD-EFGH");
    expect(t).toContain("devbox · linux · created 2m ago");
    expect(t).toContain("Claude Code on devbox");
    expect(t).toContain("every change waits for your approval");
    expect(t).toContain("Key valid 90 days");
    expect(t).toContain("Approve");
    expect(t).toContain("This wasn't me");
    // Folded, not on the first glance.
    expect(pending()).toMatch(
      /<details[^>]*>[\s\S]*203\.0\.113\.7[\s\S]*<\/details>/
    );
  });

  it("offers reconnect vs new only when the person has a computer by that name", () => {
    expect(text(pending())).not.toContain("Reconnect");
    const t = text(
      pending({
        request: {
          ...REQUEST,
          reusableComputers: [
            { id: "m-1", name: "devbox", createdAt: REQUEST.createdAt },
          ],
        },
        reuseId: "m-1",
      })
    );
    expect(t).toContain("Reconnect devbox");
    expect(t).toContain("Keeps its agents, history and rules");
    expect(t).toContain("Add as a new computer");
  });

  it("omits the agents section when the terminal asked for none", () => {
    expect(
      text(pending({ request: { ...REQUEST, agents: [] } }))
    ).not.toContain("Agents it will set up");
  });

  it("renames agents with the computer", () => {
    expect(text(pending({ computerName: "My devbox" }))).toContain(
      "Claude Code on My devbox"
    );
  });

  it("shows a refused decision as an alert", () => {
    expect(pending({ error: "That code doesn't match" })).toMatch(
      /role="alert"[^>]*>[\s\S]*That code doesn(&#x27;|')t match/
    );
  });
});

describe("terminal answers", () => {
  it("approved REASSURES: back to the terminal", () => {
    expect(
      text(renderToStaticMarkup(<ApprovedView name="devbox" />))
    ).toContain("Return to your terminal");
  });

  it("denied confirms nothing was connected", () => {
    const t = text(renderToStaticMarkup(<DeniedView name="devbox" />));
    expect(t).toContain("Rejected");
    expect(t).toContain("devbox was not connected");
  });

  it("expired / used / unknown EXPLAIN and say to run synap init again", () => {
    const t = text(
      renderToStaticMarkup(
        <GoneView title="This request expired" onEnterAnother={noop} />
      )
    );
    expect(t).toContain("This request expired");
    expect(t).toContain("synap init");
    expect(t).toContain("Enter another code");
  });

  it("a FAILED read is an error with Retry — never calm empty copy", () => {
    const html = renderToStaticMarkup(
      <FailedView message="Pod returned 502." onRetry={noop} />
    );
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Pod returned 502.");
    expect(text(html)).toContain("Retry");
  });

  it("locked explains the wait", () => {
    expect(
      text(
        renderToStaticMarkup(
          <LockedView message="Wait a few minutes, then try again." />
        )
      )
    ).toContain("Too many wrong codes");
  });

  it("enter-code asks for the code", () => {
    const t = text(
      renderToStaticMarkup(
        <EnterCodeView
          value=""
          onChange={noop}
          onSubmit={noop}
          complete={false}
        />
      )
    );
    expect(t).toContain("Enter the code from your terminal");
    expect(t).toContain("Continue");
  });
});

describe("This wasn't me", () => {
  it("POSTs decision deny to the device route", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ status: "denied" }), {
        status: 200,
      });
    }) as typeof fetch;
    expect(
      await sendDecision(denyDecision(REQUEST, "abcd-efgh"), fake)
    ).toBeNull();
    expect(calls).toEqual([
      {
        url: "/api/device",
        body: {
          requestId: REQUEST.requestId,
          userCode: "ABCDEFGH",
          decision: "deny",
        },
      },
    ]);
  });

  it("returns the pod's refusal instead of claiming success", async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({ error: "This request was already decided." }),
        {
          status: 409,
        }
      )) as typeof fetch;
    expect(await sendDecision(denyDecision(REQUEST, "ABCDEFGH"), fake)).toBe(
      "This request was already decided."
    );
  });
});
