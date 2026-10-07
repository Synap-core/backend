/**
 * The ONE agent reach mark. Rows are the inputs where candidate rules DISAGREE:
 * a broken dispatch binding (calm vs failed), an unknown/absent reach (guess vs
 * no mark), and a binding served on a non-dispatch reach (ignored).
 */
import { describe, expect, it } from "vitest";
import { resolveAgentReachMark } from "./index.js";

describe("resolveAgentReachMark", () => {
  it("absent or unknown reach ⇒ no mark (an older pod is never guessed)", () => {
    expect(resolveAgentReachMark(null)).toBeNull();
    expect(resolveAgentReachMark({})).toBeNull();
    expect(resolveAgentReachMark({ reach: "teleport" })).toBeNull();
  });

  it("pod and pull are neutral facts", () => {
    expect(resolveAgentReachMark({ reach: "pod" })).toMatchObject({
      tone: "neutral",
      glyph: "pod",
      label: "Runs in Synap",
      error: null,
    });
    expect(
      resolveAgentReachMark({ reach: "pull", binding: null })
    ).toMatchObject({
      tone: "neutral",
      glyph: "pull",
      label: "Connects in",
    });
  });

  it("a healthy dispatch binding is success and names its connector", () => {
    expect(
      resolveAgentReachMark({
        reach: "dispatch",
        binding: { toolId: "t1", provider: "github" },
      })
    ).toEqual({
      reach: "dispatch",
      tone: "success",
      glyph: "dispatch",
      label: "Synap sends it work",
      toolId: "t1",
      provider: "github",
      error: null,
    });
  });

  it("a broken dispatch binding is the FAILED mark, worded by its code", () => {
    const mark = resolveAgentReachMark({
      reach: "dispatch",
      binding: {
        toolId: "t1",
        provider: null,
        error: {
          code: "tool_inactive",
          message: "The agent's dispatch tool t1 is paused",
        },
      },
    });
    expect(mark).toMatchObject({
      tone: "danger",
      glyph: "failed",
      label: "Connector off",
      toolId: "t1",
      error: { code: "tool_inactive" },
    });
  });

  it("a binding on a non-dispatch reach is ignored", () => {
    const mark = resolveAgentReachMark({
      reach: "pull",
      binding: {
        toolId: "t1",
        provider: "x",
        error: { code: "malformed", message: "m" },
      },
    });
    expect(mark).toMatchObject({
      tone: "neutral",
      toolId: null,
      provider: null,
      error: null,
    });
  });
});
