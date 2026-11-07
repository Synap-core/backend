/**
 * THE wake rule (`deriveAgentWake`) and the template seam
 * (`resolveAgentTemplate`), pure.
 *
 * Pinned: one case per state and per reason, in the rule's order (a paused
 * agent is never awake, a broken connector never reads as working, key use is
 * not a runner, the reasons fall in their declared order), and every reason
 * the type declares is reachable, so no reason is dead.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_WAKE_REFUSALS,
  type AgentTemplateWake,
  type AgentWake,
  type AgentWakeRefusal,
} from "@synap-core/types/agents";
import {
  deriveAgentWake,
  resolveAgentTemplate,
  type AgentWakeInput,
} from "../agent-wake.js";
import type { InstalledAgentTemplate } from "../../agent-templates/installed.js";

const CLAUDE = resolveAgentTemplate({ agentType: "claude-code" })!;
const CLAUDE_WAKE: AgentTemplateWake = {
  program: "claude",
  args: ["-p", "{prompt}", "--output-format", "stream-json", "--verbose"],
  params: { prompt: { type: "text", required: true } },
  env: { strip: ["ANTHROPIC_API_KEY"] },
};
const HERMES_WAKE: AgentTemplateWake = {
  program: "hermes",
  args: ["chat", "-q", "{prompt}"],
  params: { prompt: { type: "text", required: true } },
};
const CURSOR = resolveAgentTemplate({ agentType: "cursor" })!;

/** A pull agent on a computer whose runner can start it: `can_wake`. */
const WAKEABLE: AgentWakeInput = {
  reach: "pull",
  paused: false,
  bindingBroken: false,
  nobodyRuns: true,
  template: CLAUDE,
  onComputer: true,
  waker: { online: true, wakesAgents: true },
};
const wake = (over: Partial<AgentWakeInput>): AgentWake =>
  deriveAgentWake({ ...WAKEABLE, ...over });

describe("resolveAgentTemplate — the one template seam", () => {
  it("names the template from the agent's type, built in (no catalog version)", () => {
    expect(resolveAgentTemplate({ agentType: "claude-code" })).toEqual({
      slug: "claude-code",
      label: "Claude Code",
      version: null,
      wakes: true,
      // Built in: the pod holds no wake block to serve a runner.
      wake: null,
    });
    expect(resolveAgentTemplate({ agentType: "codex" })).toMatchObject({
      label: "Codex",
      wakes: true,
    });
  });

  it("a client that cannot be started headless has a template without wake", () => {
    expect(CURSOR).toMatchObject({ slug: "cursor", wakes: false });
    expect(resolveAgentTemplate({ agentType: "raycast" })?.wakes).toBe(false);
  });

  it("an installed template wins over the built-in row: its name, its catalog version, its wake", () => {
    const installed: InstalledAgentTemplate[] = [
      {
        slug: "claude-code",
        name: "Claude Code (catalog)",
        harness: "claude-code",
        aliases: [],
        worker: true,
        wakes: true,
        wake: CLAUDE_WAKE,
        version: "h-0123456789ab",
      },
      {
        slug: "hermes",
        name: "Hermes Agent",
        harness: "hermes",
        aliases: [],
        worker: true,
        wakes: true,
        wake: HERMES_WAKE,
        version: "h-ba9876543210",
      },
    ];
    expect(
      resolveAgentTemplate({ agentType: "claude-code" }, installed)
    ).toEqual({
      slug: "claude-code",
      label: "Claude Code (catalog)",
      version: "h-0123456789ab",
      wakes: true,
      wake: CLAUDE_WAKE,
    });
    // A type the built-in registry never had: only the catalog names it.
    expect(resolveAgentTemplate({ agentType: "hermes" })).toBeNull();
    expect(resolveAgentTemplate({ agentType: "hermes" }, installed)?.slug).toBe(
      "hermes"
    );
    // The wake block a runner starts the agent with is the installed one, as installed.
    expect(
      resolveAgentTemplate({ agentType: "hermes" }, installed)?.wake
    ).toEqual(HERMES_WAKE);
  });

  it("the agent's link names its template, whatever its type says", () => {
    const installed: InstalledAgentTemplate[] = [
      {
        slug: "claude-code",
        name: "Claude Code",
        harness: "claude-code",
        aliases: [],
        worker: true,
        wakes: true,
        wake: CLAUDE_WAKE,
        version: "h-0123456789ab",
      },
    ];
    expect(
      resolveAgentTemplate(
        { agentType: "claude-code-devbox", templateSlug: "claude-code" },
        installed
      )
    ).toMatchObject({ slug: "claude-code", version: "h-0123456789ab" });
    // Unlinked, the same type names nothing.
    expect(
      resolveAgentTemplate({ agentType: "claude-code-devbox" }, installed)
    ).toBeNull();
    // A link to a template that is not installed falls back to the type.
    expect(
      resolveAgentTemplate(
        { agentType: "cursor", templateSlug: "gone" },
        installed
      )
    ).toMatchObject({ slug: "cursor", version: null });
  });

  it("a type that names no template has none, never a guess", () => {
    for (const t of ["meta", "acme", "", null, undefined])
      expect(resolveAgentTemplate({ agentType: t })).toBeNull();
  });
});

describe("deriveAgentWake — awake", () => {
  it("the pod runs a pod agent itself", () => {
    expect(wake({ reach: "pod", template: null })).toEqual({
      state: "awake",
      how: "built_in",
      why: null,
    });
  });

  it("a dispatch agent with a healthy connector", () => {
    expect(wake({ reach: "dispatch", template: null })).toEqual({
      state: "awake",
      how: "binding",
      why: null,
    });
  });

  it("a pull agent a runner served within the window", () => {
    expect(wake({ nobodyRuns: false })).toEqual({
      state: "awake",
      how: "runner",
      why: null,
    });
    // Served by a runner, even with no template to wake it again: the runner
    // is what gets it working (review nit on #823).
    expect(wake({ nobodyRuns: false, template: null })).toEqual({
      state: "awake",
      how: "runner",
      why: null,
    });
  });

  it("key use alone is not awake: never measured, or served outside the window", () => {
    expect(wake({ nobodyRuns: null }).state).toBe("can_wake");
    expect(wake({ nobodyRuns: true }).state).toBe("can_wake");
  });
});

describe("deriveAgentWake — can_wake", () => {
  it("pull, a template that wakes, a computer whose runner is online with waking on", () => {
    expect(wake({})).toEqual({ state: "can_wake", how: "runner", why: null });
  });
});

describe("deriveAgentWake — cant_wake, one reason each, first match", () => {
  const cases: Array<
    [AgentWakeRefusal, Partial<AgentWakeInput>, AgentWake["how"]]
  > = [
    ["paused", { paused: true, nobodyRuns: false }, "runner"],
    ["binding_broken", { reach: "dispatch", bindingBroken: true }, "binding"],
    ["no_template", { template: null }, null],
    ["no_template_wake", { template: CURSOR }, null],
    ["no_computer", { onComputer: false }, "runner"],
    ["no_waker", { waker: null }, "runner"],
    [
      "computer_offline",
      { waker: { online: false, wakesAgents: true } },
      "runner",
    ],
    ["wakes_off", { waker: { online: true, wakesAgents: false } }, "runner"],
  ];

  it.each(cases)("%s", (why, over, how) => {
    expect(wake(over)).toEqual({ state: "cant_wake", how, why });
  });

  it("every declared reason is reachable (no dead reason)", () => {
    expect(cases.map(([why]) => why).sort()).toEqual(
      [...AGENT_WAKE_REFUSALS].sort()
    );
  });

  it("paused wins over everything, even a pod agent or a broken connector", () => {
    expect(wake({ paused: true, reach: "pod" }).why).toBe("paused");
    expect(
      wake({ paused: true, reach: "dispatch", bindingBroken: true }).why
    ).toBe("paused");
  });

  it("the reasons fall in order: no template before no computer before no waker", () => {
    expect(wake({ template: null, onComputer: false, waker: null }).why).toBe(
      "no_template"
    );
    expect(wake({ template: CURSOR, onComputer: false, waker: null }).why).toBe(
      "no_template_wake"
    );
    expect(wake({ onComputer: false, waker: null }).why).toBe("no_computer");
    expect(wake({ waker: { online: false, wakesAgents: false } }).why).toBe(
      "computer_offline"
    );
  });
});
