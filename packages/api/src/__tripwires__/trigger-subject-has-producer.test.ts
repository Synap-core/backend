import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  TRIGGER_SUBJECT_CATEGORIES,
  buildEventPattern,
} from "@synap-core/types/automations";
import { validateEventPattern } from "@synap-core/types/events/unified";

/**
 * EVERY SUBJECT THE RULE GRAMMAR OFFERS MUST BE ABLE TO FIRE.
 *
 * We have already shipped two triggers that could not: `feed_item` (compiled to
 * `feed.new_item.completed`; the only `feed` producer emits `entity_extract`)
 * and, at the catalog layer, `external_channel.created.completed` (zero
 * producers, removed 2026-09-08). An inert trigger is worse than a missing one:
 * the rule installs `active`, reports itself live, and never runs — nothing
 * anywhere says so.
 *
 * So this guard re-derives the three conditions from SOURCE, never from a list
 * anyone maintains by hand:
 *
 *   1. A PRODUCER exists — an `emitSideEffects()` / `recordDomainMutation()`
 *      call carrying that `subjectType`.
 *   2. That producer passes a WORKSPACE. `side-effects.ts`'s
 *      `automation-trigger-match` reactor matches on
 *      `Boolean(payload.workspaceId) || subjectType === "external_message"`, so
 *      a workspace-less emit never reaches the matcher at all. This is the
 *      condition a producer census alone misses, and it is the one that keeps
 *      `user` off the list — it has a live producer. (`sharing` was withheld on
 *      this condition too until its only producer, the dead `sharing` tRPC
 *      router, was deleted; it is now pinned in the zero-producer group.)
 *   3. The compiled pattern passes `validateEventPattern`, which the rule
 *      compiler runs (`services/rules/compile.ts:201`). This keeps
 *      `entity_facet` off the list: workspace-scoped producer, but the subject
 *      is in none of the three subject vocabularies.
 *
 * ── What this guard is NOT ──────────────────────────────────────────────────
 * It does not prove a subject's every VERB fires — `notification.create.completed`
 * is still an authorable pattern nothing emits. That is a per-EVENT question the
 * catalog tier answers (`isFireableTriggerPattern` + `buildEventCatalog`); this
 * one is per-SUBJECT, which is the granularity `TriggerSubjectCategory` has.
 *
 * ── Defeat attempts, and what closed them ───────────────────────────────────
 * • A literal-only `subjectType:` scan misses `subjectType: FOCUS_SESSION_SUBJECT_TYPE`
 *   (`services/focus-sessions/close-event.ts:14`) — `focus_session` would have
 *   needed a hand-written exemption. Const aliases are RESOLVED instead.
 * • A `workspaceId:` regex misses the SHORTHAND `workspaceId,`, which is how
 *   `feed`, `command`, `proactive` and `inbox_item` actually pass it. Matching
 *   only the colon form declared four live subjects inert. Both forms match.
 * • A line-window scan around the call reads the wrong object when a call spans
 *   more than the window, or when a nested object contains the key. The call's
 *   argument object is BRACE-BALANCED instead.
 * • Test files are excluded. A fixture emitting `subjectType: "tag"` must never
 *   be able to license a trigger.
 */

const REPO = path.resolve(__dirname, "../../../..");

/**
 * Roots that can hold a real producer — `packages/*\/src` AND `apps/*\/src`.
 *
 * ⚠️ A `packages/`-only scan has produced a false "no producer" verdict THREE
 * times in one day. `inbox_item`'s producers are both in `apps/`
 * (`apps/api/src/webhooks/n8n.ts:89`, `.../intelligence.ts:72`) and `user`'s
 * only producer is `apps/api/src/webhooks/kratos.ts:67`. `inbox_item` was
 * reported as the "second unproducible trigger" on the strength of such a scan;
 * it is not, and `n8n.ts` passes a workspace, so it genuinely reaches the
 * matcher. Do not narrow this walk back to one root, and do not "fix"
 * `inbox_item` out of `TRIGGER_SUBJECT_CATEGORIES` on a `packages/`-only grep.
 */
function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    const dir = path.join(REPO, group);
    if (!fs.existsSync(dir)) continue;
    for (const pkg of fs.readdirSync(dir)) {
      const src = path.join(dir, pkg, "src");
      if (fs.existsSync(src)) roots.push(src);
    }
  }
  return roots;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.includes(".test.") &&
      !full.includes("__tripwires__") &&
      !full.includes("__tests__")
    ) {
      out.push(full);
    }
  }
  return out;
}

interface Producer {
  subject: string;
  /** The emit's `action` segment — needed for the PATTERN-granularity pass. */
  action: string | null;
  /** Does the emit carry a `workspaceId` key at all (colon OR shorthand)? */
  passesWorkspace: boolean;
  loc: string;
}

/** `const X = "literal"` bindings, so a hoisted subject name still resolves. */
function collectAliases(files: string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*["'`]([A-Za-z_][\w]*)["'`]/g
    )) {
      aliases.set(m[1]!, m[2]!);
    }
  }
  return aliases;
}

function scanProducers(): Producer[] {
  const files = sourceRoots().flatMap((r) => walk(r));
  const aliases = collectAliases(files);
  const producers: Producer[] = [];

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const call = /\b(?:emitSideEffects|recordDomainMutation)\s*\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = call.exec(src))) {
      // Brace-balance the argument object — a fixed line window either
      // truncates a long call or spills into the next one.
      let depth = 0;
      let end = m.index;
      for (let i = m.index + m[0].length - 1; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const block = src.slice(m.index, end + 1);

      const st = /subjectType\s*:\s*([^,\n]+)/.exec(block);
      if (!st) continue;
      const raw = st[1]!.trim();
      const lit = /^["'`]([A-Za-z_][\w]*)["'`]$/.exec(raw);
      const subject = lit
        ? lit[1]!
        : (aliases.get(raw.replace(/[^\w$]/g, "")) ?? null);
      if (!subject) continue; // a genuinely dynamic subject licenses nothing

      // Colon form OR ES6 shorthand — the shorthand is how four of the live
      // subjects actually pass it, and missing it is a false "inert" verdict.
      const passesWorkspace =
        /(?:^|[\s,{])workspaceId\s*(?::\s*[^,\n]|,|\s*\})/.test(block);

      const at = /(?:^|[\s,{])action\s*:\s*([^,\n]+)/.exec(block);
      const rawAction = at ? at[1]!.trim() : null;
      const actLit = rawAction
        ? /^["'`]([A-Za-z_][\w]*)["'`]$/.exec(rawAction)
        : null;
      const action = actLit
        ? actLit[1]!
        : rawAction
          ? (aliases.get(rawAction.replace(/[^\w$]/g, "")) ?? null)
          : null;

      producers.push({
        subject,
        action,
        passesWorkspace,
        loc: `${path.relative(REPO, file)}:${src.slice(0, m.index).split("\n").length}`,
      });
    }
  }
  return producers;
}

describe("every offered rule subject can actually fire", () => {
  const producers = scanProducers();

  it("the scan itself found producers (a broken scan must not pass vacuously)", () => {
    expect(
      producers.length,
      "The producer scan returned (almost) nothing — the call shape or the " +
        "source roots moved. A scan that finds nothing would fail every " +
        "subject below, but a scan that finds a HANDFUL could pass by luck; " +
        "this floor makes a silently-narrowed scan visible."
    ).toBeGreaterThan(80);
  });

  it("the matcher reactor still gates on workspaceId — the premise of this guard", () => {
    // Condition 2 is derived from ONE line in ONE file. If that line changes,
    // every "inert because workspace-less" verdict below is wrong and the
    // withheld subject (`user`) must be reconsidered.
    const src = fs.readFileSync(
      path.join(REPO, "packages/events/src/side-effects.ts"),
      "utf8"
    );
    const reactor =
      /id:\s*["'`]automation-trigger-match["'`][\s\S]{0,600}?match:\s*\(payload\)\s*=>\s*([\s\S]{0,200}?)async handler/.exec(
        src
      );
    expect(
      reactor,
      "the automation-trigger-match reactor's `match` moved — re-derive condition 2"
    ).toBeTruthy();
    expect(
      reactor![1]!.replace(/\s+/g, " ").trim(),
      "The reactor no longer requires a workspace (or exempts a different " +
        "subject). The subject withheld for passing no workspace — `user` — " +
        "may now be fireable, and this guard's condition 2 is stale."
    ).toBe(
      'Boolean(payload.workspaceId) || payload.subjectType === "external_message",'
    );
  });

  it.each([...TRIGGER_SUBJECT_CATEGORIES])(
    "`%s` has a live producer that reaches the matcher",
    (subject) => {
      const mine = producers.filter((p) => p.subject === subject);
      expect(
        mine.length,
        `No \`emitSideEffects\`/\`recordDomainMutation\` call site emits ` +
          `subjectType "${subject}". A subject with no producer is a trigger ` +
          `that installs active and never fires. Remove it from ` +
          `TRIGGER_SUBJECT_CATEGORIES, or add the producer first.`
      ).toBeGreaterThan(0);

      // `external_message` is the reactor's own exemption — a pod-wide inbound
      // message legitimately carries no workspace and still reaches the matcher.
      if (subject === "external_message") return;

      const reaching = mine.filter((p) => p.passesWorkspace);
      expect(
        reaching.length,
        `Every producer of "${subject}" emits without a workspaceId ` +
          `(${mine.map((p) => p.loc).join(", ")}), so the ` +
          `automation-trigger-match reactor skips all of them and no rule on ` +
          `this subject can ever fire. Either give a producer the workspace it ` +
          `already has in scope, or remove the subject.`
      ).toBeGreaterThan(0);
    }
  );

  it.each([...TRIGGER_SUBJECT_CATEGORIES])(
    "`%s` compiles to a pattern the rule door accepts",
    (subject) => {
      // The wildcard is what an absent verb now compiles to, and it is the
      // shape offered for every non-CRUD subject — so it is the one that must
      // survive `validateEventPattern`, which `compile.ts` runs before storing.
      expect(() => validateEventPattern(`${subject}.*`)).not.toThrow();
    }
  );

  // ── PATTERN granularity ───────────────────────────────────────────────────
  //
  // Everything above is SUBJECT-level, and a subject-level guard is blind to a
  // per-VERB hole: `inbox_item.received` fires, `inbox_item.analyzed` does not.
  // For ~10 of the 25 subjects the emitted action is a DOMAIN verb
  // (`stage_changed`, `entity_extract`, `imported`, `post`, `execute` …) that is
  // not an `ActionVerb` at all, so EVERY verb-picked pattern for them is inert
  // and the subject wildcard `X.*` is their only fireable form.
  //
  // That is a real property of the product, not a defect to fix here — but it
  // must be PINNED rather than assumed, or the wildcard path can be removed by
  // someone who believes a verb works. This sweep derives it from the same scan
  // and asserts the exact set.
  const ACTION_VERBS = [
    "created",
    "updated",
    "deleted",
    "received",
    "completed",
    "approved",
    "rejected",
  ] as const;

  /** `subject.action` pairs a live, workspace-passing producer really emits. */
  const emitted = new Set(
    producers
      .filter((p) => p.passesWorkspace && p.action)
      .map((p) => `${p.subject}.${p.action}`)
  );

  it("records which subjects are WILDCARD-ONLY (no verb of theirs can ever fire)", () => {
    const wildcardOnly = TRIGGER_SUBJECT_CATEGORIES.filter((subject) =>
      ACTION_VERBS.every((actionVerb) => {
        const pattern = buildEventPattern({
          triggerType: "event",
          subjectCategory: subject,
          actionVerb,
        });
        const [subj, action] = pattern.split(".");
        return !emitted.has(`${subj}.${action}`);
      })
    );

    // Derived from the scan, pinned as a literal. A subject LEAVING this set is
    // good news (a verb of its became fireable) and a subject JOINING it means
    // a producer's action changed under a picker that still offers verbs — both
    // are things to look at, which is why the assertion is exact rather than a
    // count.
    expect(
      [...wildcardOnly].sort(),
      "The wildcard-only set moved. These subjects emit DOMAIN actions, so " +
        "`X.*` (an ABSENT actionVerb) is the only pattern of theirs that can " +
        "fire — do not remove the wildcard path in `buildEventPattern`, and do " +
        "not let a picker offer them a verb."
    ).toEqual([
      // Domain actions with no `ActionVerb` spelling at all:
      // `channel_message`(sent) · `command`(execute) · `connector_sync`(complete)
      // `feed`(entity_extract) · `focus_session`(stage_changed, close, promote,
      // revert, spawn_project, triage_accept, triage_discard, grant_capability)
      // `hydration`(imported) · `messaging_account`(created/disconnected/
      // reconnection_required) · `proactive`(post).
      "channel_message",
      "command",
      "connector_sync",
      "feed",
      "focus_session",
      "hydration",
      "messaging_account",
      "proactive",
      // `proposal` is here for a DIFFERENT and much sneakier reason: it emits
      // `approved` / `created` / `rejected`, which ARE `ActionVerb` members —
      // but `VERB_TO_EVENT_ACTION` rewrites `created` → `create` on the way to
      // the pattern, so the grammar authors `proposal.create.completed` while
      // the producer emits `proposal.created`. A mood bridge built for `entity`
      // silently breaks the one subject whose real actions are already past
      // tense. Nothing but this derivation would have found that.
      "proposal",
    ]);

    // ⚠️ The assertion above does NOT check the wildcard path, and its own
    // failure message tells you not to remove it. I mutated `buildEventPattern`
    // to drop the absent-verb branch and this test stayed GREEN — a guard
    // asserting something it never looks at, which is the exact defect class
    // this wave exists to remove. So check it, here, for the subjects whose
    // ONLY fireable form it is:
    for (const subject of wildcardOnly) {
      const wildcard = buildEventPattern({
        triggerType: "event",
        subjectCategory: subject,
      });
      expect(
        wildcard,
        `An absent verb on "${subject}" no longer compiles to a wildcard. ` +
          `No VERB-bearing pattern for this subject can fire, so this is now a ` +
          `subject with no authorable trigger at all.`
      ).toBe(`${subject}.*`);

      expect(
        [...emitted].some((pair) => pair.startsWith(`${subject}.`)),
        `"${subject}.*" matches nothing a producer emits with a workspace.`
      ).toBe(true);
    }
  });

  it("the grammar cannot author `inbox_item.analyzed`, which has no workspace", () => {
    // The asymmetry the subject-level pass cannot see, pinned from BOTH ends.
    // `apps/api/src/webhooks/intelligence.ts:72` emits `inbox_item.analyzed`
    // with no workspace, so it never reaches the matcher; `n8n.ts:89` emits
    // `inbox_item.received` WITH one, so the subject stays.
    expect(emitted.has("inbox_item.received")).toBe(true);
    expect(emitted.has("inbox_item.analyzed")).toBe(false);

    // And no verb the grammar accepts can compile to the inert one — the
    // PATTERN_MAP entry pins `inbox_item` to `.received.completed`, and an
    // absent verb gives the wildcard.
    for (const actionVerb of ACTION_VERBS) {
      expect(
        buildEventPattern({
          triggerType: "event",
          subjectCategory: "inbox_item",
          actionVerb,
        })
      ).toBe("inbox_item.received.completed");
    }
  });

  it("subjects deliberately WITHHELD are still unfireable (so re-adding one is a decision)", () => {
    const verdict = (s: string) => {
      const mine = producers.filter((p) => p.subject === s);
      return {
        producers: mine.length,
        reaching: mine.filter((p) => p.passesWorkspace).length,
      };
    };
    // Zero producers anywhere.
    expect(verdict("external_channel").producers).toBe(0);
    expect(verdict("tag").producers).toBe(0);
    // `sharing` stays in `SUBJECT_TYPES` so historical `sharing.*` events still
    // render, but its only producer (the `sharing` tRPC router) was deleted as
    // dead and unsafe. A producer reappearing is a DECISION, not drift: if it
    // passes a workspace, add `sharing` to TRIGGER_SUBJECT_CATEGORIES; if not,
    // move it back into the workspace-less group below.
    expect(
      verdict("sharing").producers,
      "`sharing` has a producer again — decide whether it is a trigger subject " +
        "(see the comment above) instead of leaving it silently withheld."
    ).toBe(0);
    // Producers exist but NONE passes a workspace → cannot reach the matcher.
    for (const s of ["user"]) {
      expect(verdict(s).producers, `${s} lost its producer`).toBeGreaterThan(0);
      expect(
        verdict(s).reaching,
        `"${s}" now has a workspace-scoped producer, so it CAN fire and is ` +
          `being withheld for no reason. Add it to TRIGGER_SUBJECT_CATEGORIES.`
      ).toBe(0);
    }
    // Workspace-scoped producer, but the subject is outside every event
    // vocabulary, so `compile.ts` refuses the pattern at the door.
    expect(verdict("entity_facet").reaching).toBeGreaterThan(0);
    expect(() => validateEventPattern("entity_facet.*")).toThrow();
  });
});
