/**
 * The ONE test double of the `presence` tRPC router, for a test whose
 * `lib/trpc` mock renders a page that reaches a proof door
 * (`use-sensitivity.ts`, read by `use-approve`, `use-presence-door`, the
 * review page and the passkeys card):
 *
 *   vi.mock("<path>/lib/trpc", async () => ({
 *     trpc: {
 *       presence: (await import("<path>/app/_lib/presence/__tests__/trpc-double")).presenceTrpcDouble(),
 *       …
 *     },
 *   }));
 *
 * It answers what a pod whose admins never chose anything answers
 * (`presence.sensitivity`): the mode `enforce` and nothing switched off, so
 * the sensitive lists hold as written (W5). The default is given here once,
 * so a hand-written mock never has to restate it (backend#869: seven page
 * tests crashed on a mock with no `presence` when the doors began reading
 * it).
 */
import {
  DEFAULT_PRESENCE_SENSITIVITY,
  type PresenceSensitivityChoice,
} from "@synap-core/types/presence";

export type PodSensitivityDouble = PresenceSensitivityChoice & {
  mode: "enforce" | "report";
};

export function presenceTrpcDouble(
  sensitivity: PodSensitivityDouble = {
    ...DEFAULT_PRESENCE_SENSITIVITY,
    mode: "enforce",
  }
) {
  return {
    sensitivity: {
      useQuery: () => ({
        data: sensitivity,
        isLoading: false,
        isError: false,
        error: null,
        refetch() {},
      }),
    },
  };
}
