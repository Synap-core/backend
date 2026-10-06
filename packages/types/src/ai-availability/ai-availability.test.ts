import { describe, expect, it } from "vitest";
import {
  AI_AVAILABILITY_KINDS,
  AI_AVAILABILITY_PRECEDENCE,
  AI_FAILURE_CODES,
  aiAvailabilityBanner,
  aiAvailabilityCopy,
  resolveAiAvailability,
  resolveAiFailureState,
  resolveAiViewerRole,
  type AiBillingInput,
} from "./index.js";
import { lensStatusBanner } from "../lens/header.js";
import { STATUS_LABELS } from "../vocabulary/index.js";

function billing(
  over: Partial<Extract<AiBillingInput, { readFailed: false }>> = {}
): AiBillingInput {
  return {
    readFailed: false,
    state: "ok",
    threshold: null,
    dismissKey: null,
    resetsAt: null,
    viewerRole: "pod_owner",
    canTopUp: true,
    action: "none",
    ...over,
  };
}

describe("precedence — worst first", () => {
  it("is suspended › not_entitled › credits_empty › budget_paused › service_down › provider_issue › credits_low › ok", () => {
    expect(AI_AVAILABILITY_PRECEDENCE).toEqual([
      "suspended",
      "not_entitled",
      "credits_empty",
      "budget_paused",
      "service_down",
      "provider_issue",
      "credits_low",
      "ok",
    ]);
  });

  it("an empty CP balance outranks a service outage", () => {
    const a = resolveAiAvailability({
      billing: billing({ state: "empty", action: "top_up" }),
      health: "unhealthy",
    });
    expect(a.kind).toBe("credits_empty");
  });

  it("a wire suspension outranks a CP low warning", () => {
    const a = resolveAiAvailability({
      billing: billing({ state: "low", threshold: 10, action: "top_up" }),
      failureCode: "access_suspended",
    });
    expect(a.kind).toBe("suspended");
  });

  it("an operator outage outranks low credits", () => {
    const a = resolveAiAvailability({
      billing: billing({ state: "low", threshold: 20, action: "top_up" }),
      failureCode: "circuit_open",
    });
    expect(a.kind).toBe("service_down");
  });

  it("nothing wrong is ok, with no surfaces", () => {
    const a = resolveAiAvailability({ billing: billing(), health: "ok" });
    expect(a.kind).toBe("ok");
    expect(a.surfaces).toEqual({
      ambient: false,
      banner: false,
      composerHint: false,
    });
    expect(aiAvailabilityCopy(a)).toBeNull();
  });
});

describe("every refusal code is classified", () => {
  it("each pod wire code resolves to a kind or to transient null — never throws, never leaks", () => {
    for (const code of AI_FAILURE_CODES) {
      const k = resolveAiFailureState(code);
      expect(k === null || AI_AVAILABILITY_KINDS.includes(k)).toBe(true);
    }
    // non-vacuous
    expect(AI_FAILURE_CODES.length).toBeGreaterThanOrEqual(19);
  });

  it("transient faults are NOT availability states", () => {
    for (const code of [
      "rate_limited",
      "rate_limit",
      "timeout",
      "context_length_exceeded",
      "content_filter",
      "cancelled",
      "bad_request",
      "upstream_error",
    ]) {
      expect(resolveAiFailureState(code)).toBeNull();
    }
  });

  it("account and operator codes map to their state", () => {
    expect(resolveAiFailureState("credits_empty")).toBe("credits_empty");
    expect(resolveAiFailureState("account_quota_exceeded")).toBe(
      "credits_empty"
    );
    expect(resolveAiFailureState("access_suspended")).toBe("suspended");
    expect(resolveAiFailureState("not_entitled")).toBe("not_entitled");
    expect(resolveAiFailureState("llm_budget_exceeded")).toBe("budget_paused");
    expect(resolveAiFailureState("provider_no_credit")).toBe("provider_issue");
    expect(resolveAiFailureState("insufficient_credit")).toBe("provider_issue");
    expect(resolveAiFailureState("circuit_open")).toBe("service_down");
  });

  it("an unknown token (a newer IS's open tail) is never guessed into a state", () => {
    expect(resolveAiFailureState("something_new")).toBeNull();
    expect(resolveAiFailureState("toString")).toBeNull();
    expect(resolveAiFailureState(undefined)).toBeNull();
  });
});

describe("a failed billing read is not ok", () => {
  it("yields kind null + readFailed, no banner, no calm", () => {
    const a = resolveAiAvailability({ billing: { readFailed: true } });
    expect(a.kind).toBeNull();
    expect(a.readFailed).toBe(true);
    expect(a.surfaces.banner).toBe(false);
    expect(aiAvailabilityBanner(a)).toBeNull();
    expect(aiAvailabilityCopy(a)).toBeNull();
  });

  it("a wire-proven state still shows beside the failed read", () => {
    const a = resolveAiAvailability({
      billing: { readFailed: true },
      failureCode: "credits_empty",
      role: "member",
    });
    expect(a.kind).toBe("credits_empty");
    expect(a.readFailed).toBe(true);
  });
});

describe("the CTA follows the viewer", () => {
  it("only a CP `member` is a member; owner, admin, pod owner and an unread block pay", () => {
    expect(resolveAiViewerRole(billing({ viewerRole: "member" }))).toBe(
      "member"
    );
    for (const viewerRole of ["pod_owner", "owner", "admin"] as const)
      expect(resolveAiViewerRole(billing({ viewerRole }))).toBe("payer");
    expect(resolveAiViewerRole({ readFailed: true })).toBe("payer");
    expect(resolveAiViewerRole(null)).toBe("payer");
  });

  it("a member gets ask_admin", () => {
    const a = resolveAiAvailability({
      failureCode: "credits_empty",
      role: "member",
    });
    expect(a.action).toBe("ask_admin");
    expect(
      aiAvailabilityCopy(a, { podName: "Acme" })?.askAdminMessage
    ).toContain("Acme");
  });

  it("a payer who can buy a pack gets top_up, otherwise upgrade", () => {
    expect(
      resolveAiAvailability({
        failureCode: "credits_empty",
        role: "payer",
        canTopUp: true,
      }).action
    ).toBe("top_up");
    expect(
      resolveAiAvailability({
        failureCode: "credits_empty",
        role: "payer",
        canTopUp: false,
      }).action
    ).toBe("upgrade");
  });

  it("a member viewerRole from the CP defaults the role", () => {
    const a = resolveAiAvailability({
      failureCode: "not_entitled",
      billing: billing({ viewerRole: "member", canTopUp: false }),
    });
    expect(a.action).toBe("ask_admin");
  });

  it("the CP's action is the SSOT when the CP proved the state", () => {
    const a = resolveAiAvailability({
      billing: billing({
        state: "suspended",
        action: "fix_payment",
        viewerRole: "admin",
      }),
    });
    expect(a.action).toBe("fix_payment");
    expect(aiAvailabilityCopy(a)?.cta).toBe("Fix payment");
  });

  it("a payer on a wire suspension is told to fix payment", () => {
    expect(
      resolveAiAvailability({ failureCode: "access_suspended", role: "payer" })
        .action
    ).toBe("fix_payment");
  });
});

describe("dismiss rules", () => {
  it("credits_low's key changes per threshold crossed", () => {
    const at = (threshold: number) =>
      resolveAiAvailability({
        billing: billing({
          state: "low",
          threshold,
          action: "top_up",
          dismissKey: "cp-low",
        }),
      });
    const k20 = at(20).dismissKey;
    const k10 = at(10).dismissKey;
    const k5 = at(5).dismissKey;
    expect(new Set([k20, k10, k5]).size).toBe(3);
    expect(at(10).dismissScope).toBe("threshold");
    expect(at(10).thresholdPct).toBe(10);
  });

  it("empty / not_entitled / suspended dismiss for the session", () => {
    for (const code of ["credits_empty", "not_entitled", "access_suspended"]) {
      expect(resolveAiAvailability({ failureCode: code }).dismissScope).toBe(
        "session"
      );
    }
  });

  it("operator states hold until the condition changes", () => {
    const a = resolveAiAvailability({
      failureCode: "llm_budget_exceeded",
      resetsAt: "2026-11-01",
    });
    const b = resolveAiAvailability({
      failureCode: "llm_budget_exceeded",
      resetsAt: "2026-12-01",
    });
    expect(a.dismissScope).toBe("condition");
    expect(a.dismissKey).not.toBe(b.dismissKey);
  });

  it("the composer hint shows only when blocked (and is the non-dismissible surface)", () => {
    expect(
      resolveAiAvailability({ failureCode: "credits_empty" }).surfaces
        .composerHint
    ).toBe(true);
    expect(
      resolveAiAvailability({ failureCode: "llm_budget_exceeded" }).surfaces
        .composerHint
    ).toBe(true);
    expect(
      resolveAiAvailability({ health: "unhealthy" }).surfaces.composerHint
    ).toBe(false);
    expect(
      resolveAiAvailability({
        billing: billing({ state: "low", threshold: 5, action: "top_up" }),
      }).surfaces.composerHint
    ).toBe(false);
  });
});

describe("operator states carry no CTA", () => {
  it.each([
    ["llm_budget_exceeded", undefined],
    ["provider_no_credit", undefined],
    ["circuit_open", undefined],
    [undefined, "unhealthy"],
    [undefined, "degraded"],
  ] as const)("code=%s health=%s", (failureCode, health) => {
    const a = resolveAiAvailability({
      failureCode,
      health,
      role: "payer",
      canTopUp: true,
      failureAction: "top_up",
    });
    expect(a.actor).toBe("operator");
    expect(a.action).toBe("none");
    expect(a.tone).toBe("info");
    expect(aiAvailabilityCopy(a)?.cta).toBeNull();
    expect(aiAvailabilityBanner(a)?.action).toBeNull();
  });
});

describe("copy + vocabulary", () => {
  it("every non-ok kind has a status label in the vocabulary", () => {
    for (const k of AI_AVAILABILITY_KINDS) {
      if (k === "ok") continue;
      expect(STATUS_LABELS[k]).toBeTruthy();
    }
  });

  it("low credits title carries the threshold", () => {
    const a = resolveAiAvailability({
      billing: billing({ state: "low", threshold: 10, action: "top_up" }),
    });
    expect(aiAvailabilityCopy(a)).toMatchObject({
      label: "Low credits",
      title: "10% credits left",
      cta: "Top up",
    });
  });
});

describe("the lens banner: warning sits between error and info", () => {
  it("error › warning › info regardless of recency", () => {
    const info = {
      key: "i",
      tone: "info" as const,
      title: "I",
      occurredAt: "2026-10-06T12:00:00Z",
    };
    const warning = {
      key: "w",
      tone: "warning" as const,
      title: "W",
      occurredAt: "2026-10-06T11:00:00Z",
    };
    const error = {
      key: "e",
      tone: "error" as const,
      title: "E",
      occurredAt: "2026-10-06T10:00:00Z",
    };
    expect(lensStatusBanner([info, warning])?.tone).toBe("warning");
    expect(lensStatusBanner([warning, info, error])?.tone).toBe("error");
    expect(lensStatusBanner([info, warning, error])?.more).toBe(2);
  });

  it("an availability banner folds in and carries its CTA", () => {
    const low = aiAvailabilityBanner(
      resolveAiAvailability({
        billing: billing({ state: "low", threshold: 20, action: "top_up" }),
      })
    );
    const storage = {
      key: "pod.storage_warning|",
      tone: "info" as const,
      title: "Storage at 91%",
    };
    const banner = lensStatusBanner([storage, low!]);
    expect(banner?.tone).toBe("warning");
    expect(banner?.action).toEqual({ kind: "top_up", label: "Top up" });
  });
});
