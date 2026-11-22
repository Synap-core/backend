/**
 * The Renderers card, rendered (react-dom/server) in each state it answers:
 * loading, a failed read (error + Retry, never "Not installed"), not
 * installed (Install), installed (its version, Reinstall latest), another
 * set (no action), and a refusal kept on the row with its reason and, when
 * the pod is not enrolled, the command that fixes it.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/updates",
}));
vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));

import { RenderersBody, type RenderersBodyState } from "./renderers-card";
import type { RenderersRowView } from "./renderers-model";
import { en } from "./copy";

const render = (state: RenderersBodyState) =>
  renderToStaticMarkup(<RenderersBody state={state} />);

const ready = (
  view: RenderersRowView,
  over: Partial<Extract<RenderersBodyState, { kind: "ready" }>> = {}
): RenderersBodyState => ({
  kind: "ready",
  view,
  last: null,
  installing: false,
  onInstall: () => {},
  ...over,
});

const NONE: RenderersRowView = { state: { kind: "none" }, action: "install" };
const INSTALLED: RenderersRowView = {
  state: { kind: "installed", version: "h-0123456789ab" },
  action: "reinstall",
};

describe("RenderersBody", () => {
  it("loading draws a row skeleton, no state yet", () => {
    const out = render({ kind: "loading" });
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toContain(en["renderers.state.none"]);
  });

  // Catches: a failed status read shown as "Not installed" with Install.
  it("a failed read is an error with Retry, never Not installed", () => {
    const out = render({ kind: "failed", onRetry: () => {} });
    expect(out).toContain("Couldn’t read which renderers this pod has.");
    expect(out).toContain(">Retry<");
    expect(out).not.toContain(en["renderers.state.none"]);
    expect(out).not.toContain(">Install<");
  });

  it("not installed: the mark, why it matters, and Install", () => {
    const out = render(ready(NONE));
    expect(out).toContain(en["renderers.state.none"]);
    expect(out).toContain(en["renderers.none"]);
    expect(out).toContain(">Install<");
    expect(out).not.toContain(en["renderers.action.reinstall"]);
  });

  it("installed: the version and Reinstall latest", () => {
    const out = render(ready(INSTALLED));
    expect(out).toContain("Installed");
    expect(out).toContain("Version h-0123456789ab");
    expect(out).toContain(en["renderers.action.reinstall"]);
    expect(out).not.toContain(">Install<");
  });

  it("another set: named, with no action", () => {
    const out = render(
      ready({
        state: { kind: "other", slug: "acme-renderers", version: "1.2.0" },
        action: null,
      })
    );
    expect(out).toContain("acme-renderers (1.2.0) is installed instead.");
    expect(out).not.toContain(">Install<");
    expect(out).not.toContain(en["renderers.action.reinstall"]);
  });

  // Catches: a refusal that only shows as a raw install error.
  it("a plan refusal stays on the row, in words", () => {
    const out = render(
      ready(NONE, {
        last: {
          kind: "refused",
          refusal: "plan_required",
          detail: "The official renderers come with a Synap plan…",
        },
      })
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain("needs a Synap plan");
    expect(out).not.toContain("synap pod-key enroll");
  });

  it("a pod that is not enrolled is told the command", () => {
    const out = render(
      ready(NONE, {
        last: { kind: "refused", refusal: "pod_not_enrolled", detail: "x" },
      })
    );
    expect(out).toContain(en["renderers.refused.pod_not_enrolled"]);
    expect(out).toContain("synap pod-key enroll");
  });

  it("right after an install, says it just happened", () => {
    const out = render(ready(INSTALLED, { last: { kind: "installed" } }));
    expect(out).toContain("Version h-0123456789ab, installed just now");
  });
});
