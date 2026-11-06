/**
 * The ONE test double of `services/presence/mode.ts`, for a unit test that
 * mocks the pod's presence settings instead of reading `pod_settings`:
 *
 *   vi.mock("<path>/services/presence/mode.js", async () =>
 *     (await import("<path>/services/presence/__tests__/mode-double.js")).presenceModeDouble()
 *   );
 *
 * It answers what a pod whose admins never chose anything answers: the mode
 * from `SYNAP_PRESENCE_PROOF` (`enforce`, else `report`, read at call time so
 * a test may flip it), and the default sensitivity (nothing switched off, so
 * the sensitive lists hold as written, W5).
 *
 * Typed as the whole module (`typeof Mode`): an export added to `mode.ts`
 * fails the typecheck HERE until the double gives it, instead of failing a
 * dozen hand-written `vi.mock` factories one CI run at a time (backend#869:
 * the gate began reading `readPresenceSensitivity`, and every hand mock that
 * held only `readPresenceMode` went red). The writes and the event reads are
 * not doubled: a test that needs them reads the real module (a pglite test).
 */
import { DEFAULT_PRESENCE_SENSITIVITY } from "@synap-core/types/presence";
import type * as Mode from "../mode.js";

function notDoubled(name: string) {
  return async (..._args: unknown[]): Promise<never> => {
    throw new Error(
      `presence mode double: ${name} is not doubled; use the real module (a pglite test).`
    );
  };
}

export function presenceModeDouble(): typeof Mode {
  return {
    PRESENCE_MODE_DEFAULT: "enforce",
    invalidatePresenceMode: () => undefined,
    readPresenceMode: async () => ({
      mode:
        process.env.SYNAP_PRESENCE_PROOF === "enforce" ? "enforce" : "report",
      source: "default",
      changedBy: null,
      changedAt: null,
    }),
    readPresenceSensitivity: async () => ({
      ...DEFAULT_PRESENCE_SENSITIVITY,
      changedBy: null,
      changedAt: null,
    }),
    writePresenceMode: notDoubled("writePresenceMode"),
    writePresenceSensitivity: notDoubled("writePresenceSensitivity"),
    missingSince: notDoubled("missingSince"),
    recordModeChange: notDoubled("recordModeChange"),
  };
}
