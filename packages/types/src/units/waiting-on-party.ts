/**
 * WHO a waiting-on reason waits on (R4, `WAITING_ON_REASONS`): a person, other
 * work, or the outside world. A surface that says "waiting on you" reads the
 * person reasons from here; before this table the app kept its own hand subset
 * (`WAITS_ON_A_PERSON` in synap-app `headless/goal/model.ts`) that nothing
 * pinned, so a new reason fell to "not a person" silently.
 *
 * Keyed by EVERY reason: a reason added to `WAITING_ON_REASONS` and not
 * classified here stops the build.
 */
import { WAITING_ON_REASONS, type WaitingOnReason } from "./goal.js";

export type WaitingOnParty = "person" | "work" | "world";

export const WAITING_ON_REASON_PARTY = {
  input: "person",
  approval: "person",
  access: "person",
  another_work: "work",
  outside_world: "world",
  external: "world",
  date: "world",
} as const satisfies Record<WaitingOnReason, WaitingOnParty>;

/** The reasons a person's act unblocks, in reason order. */
export const WAITS_ON_A_PERSON: readonly WaitingOnReason[] =
  WAITING_ON_REASONS.filter((r) => WAITING_ON_REASON_PARTY[r] === "person");

/** True when `reason` is one a person's act unblocks; unknown ⇒ false. */
export function waitsOnAPerson(reason: string | null | undefined): boolean {
  return (WAITS_ON_A_PERSON as readonly string[]).includes(reason ?? "");
}
