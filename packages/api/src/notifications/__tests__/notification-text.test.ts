/**
 * A notification's words come from its registry row (`renderNotificationText`).
 * A row declaring `messageSyntax: "icu"` picks its words from the producer's
 * tokens; every other row interpolates `{{variable}}` as before.
 *
 * `security.factor_changed` is driven from the producer's own data builder
 * (`factorChangedData`) through the real registry row, so a producer that
 * starts sending words again, or a row that stops reading `named`, fails here.
 * A Kratos passkey change has no label: it once read "Just now. If it wasn't
 * you…".
 */
import { describe, expect, it, vi } from "vitest";

// The presence gate and proof verifier are not this seam: only the data
// builder of `factors.ts` is read here.
vi.mock("../../services/presence/gate.js", () => ({}));
vi.mock("../../services/presence/proof.js", () => ({}));
import { parseMessage } from "@synap-core/types/i18n";
import { renderNotificationText } from "../NotificationService.js";
import { NOTIFICATION_REGISTRY, getNotificationDef } from "../registry.js";
import { factorChangedData } from "../../services/presence/factors.js";

const FACTOR_CHANGED = getNotificationDef("security.factor_changed")!;
const AFTERWORD = "If it wasn’t you, remove it in pod admin, Security.";

function factorChanged(
  factor: "passkey" | "device_key",
  change: "added" | "removed" | "changed",
  label: string | null
) {
  return renderNotificationText(
    FACTOR_CHANGED,
    factorChangedData({ factor, change, label })
  );
}

describe("security.factor_changed — the registry owns the words", () => {
  it("the row is an ICU message row", () => {
    expect(FACTOR_CHANGED.messageSyntax).toBe("icu");
  });

  it("a named factor: its name, then the afterword", () => {
    expect(factorChanged("device_key", "added", "Ana’s iPhone")).toEqual({
      title: "A device key was added to your account",
      body: `Ana’s iPhone. ${AFTERWORD}`,
    });
  });

  it("GUARDRAIL: no label (a Kratos passkey change) drops the label sentence: no 'Just now', no leading '. '", () => {
    const text = factorChanged("passkey", "changed", null);
    expect(text).toEqual({
      title: "A passkey was added to or removed from your account",
      body: AFTERWORD,
    });
    expect(text.body).not.toContain("Just now");
    expect(text.body.startsWith(".")).toBe(false);
  });

  it("a blank label is no label", () => {
    expect(factorChanged("device_key", "removed", "   ").body).toBe(AFTERWORD);
  });

  it("the label is content: braces in it print as typed", () => {
    expect(factorChanged("device_key", "added", "lab {x} #1").body).toBe(
      `lab {x} #1. ${AFTERWORD}`
    );
  });

  it.each([
    ["passkey", "added", "A passkey was added to your account"],
    ["passkey", "removed", "A passkey was removed from your account"],
    [
      "passkey",
      "changed",
      "A passkey was added to or removed from your account",
    ],
    ["device_key", "added", "A device key was added to your account"],
    ["device_key", "removed", "A device key was removed from your account"],
    [
      "device_key",
      "changed",
      "A device key was added to or removed from your account",
    ],
  ] as const)("%s %s: %s", (factor, change, title) => {
    expect(factorChanged(factor, change, "Key 1")).toEqual({
      title,
      body: `Key 1. ${AFTERWORD}`,
    });
  });

  it("the producer sends tokens only, never words", () => {
    expect(
      factorChangedData({ factor: "passkey", change: "added", label: null })
    ).toEqual({ change: "added", factor: "passkey", named: "no", label: null });
  });
});

describe("renderNotificationText — mustache rows are unchanged", () => {
  it("interpolates {{variable}} and prints a missing value as nothing", () => {
    expect(
      renderNotificationText(
        { titleTemplate: "Hi {{name}}", bodyTemplate: "{{missing}}done" },
        { name: "Ana" }
      )
    ).toEqual({ title: "Hi Ana", body: "done" });
  });

  it("an ICU-looking text in a mustache row is left alone", () => {
    expect(
      renderNotificationText(
        { titleTemplate: "{a, select, other {x}}", bodyTemplate: "" },
        { a: "b" }
      ).title
    ).toBe("{a, select, other {x}}");
  });
});

describe("every ICU message row parses", () => {
  const icuRows = NOTIFICATION_REGISTRY.filter(
    (def) => def.messageSyntax === "icu"
  );

  it("the scan sees the ICU rows, and the parser still refuses a malformed message", () => {
    expect(icuRows.map((def) => def.type)).toContain("security.factor_changed");
    expect(() => parseMessage("{named, select, yes {x}}")).toThrow();
    expect(() => parseMessage("it wasn'{t}")).toThrow();
  });

  it.each(icuRows.map((def) => [def.type, def] as const))(
    "%s: title and body are in the ICU subset",
    (_type, def) => {
      expect(() => parseMessage(def.titleTemplate)).not.toThrow();
      expect(() => parseMessage(def.bodyTemplate)).not.toThrow();
    }
  );
});
