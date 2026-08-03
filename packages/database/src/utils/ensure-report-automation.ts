/**
 * Ensure Report Automation ("Generate report")
 *
 * Seeds THE report automation into a workspace: a MANUALLY-triggered, multi-round
 * AI flow that gathers real workspace state, interprets it across three AI rounds,
 * and materializes a `report` entity whose BODY is Synap-flavoured markdown.
 *
 * WHY THIS HOME (and not a workspace template):
 *   A workspace-template automation (`workspace-templates/*.yaml` → `flowAutomations`)
 *   only lands in workspaces provisioned FROM that template. This automation is not
 *   domain-specific — it is the pod-level "tell me what's going on here" verb, and it
 *   must exist in EVERY workspace including ones that predate it. That is exactly the
 *   contract `ensureDefaultCommands` / `ensureDefaultRelationDefs` implement: an
 *   idempotent, name-keyed reconcile that runs from the workspace-init worker for new
 *   workspaces AND from `workspaces.get` for existing ones. Same pattern, same file
 *   shape, same package (@synap/database, so both @synap/api and @synap/jobs can call
 *   it without a cycle).
 *
 * WHAT IT DEPENDS ON (all verified against the live engine, 2026-07-26):
 *   - `capability` nodes with `verbId: "ai.generate"` run SYNCHRONOUSLY through the
 *     capability router and return the model output DIRECTLY as `steps.<id>.output`
 *     (builtin-verbs.ts: `aiGenerateHandler` → `generateViaIS` → `data.output`).
 *     `ai.generate` is in READ_ONLY_BUILTIN_VERBS → auto-runs, no grant, no proposal.
 *     `maxTokens` is capped at 2000 by its zod schema.
 *   - `query` nodes read the workspace lens ∪ pod-wide rows, owner-floored
 *     (`entityQueryVisibilityWhere`). Deterministic — no LLM in the gather stage.
 *   - `continueOnError: true` records `{ error: "..." }` as that step's output and
 *     keeps walking the DAG; the default is FAIL-FAST.
 *   - The `entity_create` output node accepts `body?: string` (markdown) and
 *     materializes it into a `documents` row linked via `entities.documentId`.
 *   - `deepResolveTemplates` preserves the native value when the whole string is one
 *     `{{...}}` placeholder — which is why `body: "{{steps.assemble.output}}"` hands
 *     the assembler's markdown through unstringified.
 *
 * KNOWN LIMITS (deliberate, stated rather than papered over):
 *   - RESOLVED, and this bullet used to say the opposite. The `query` node now
 *     addresses the entities table's REAL COLUMNS for both ordering and
 *     filtering, through one shared `QUERY_COLUMNS` allowlist
 *     (`createdAt`/`updatedAt`/`title`/`type`) in `automation-executor.ts`.
 *     Precedence: an explicit `properties.` prefix ALWAYS means jsonb (the
 *     escape hatch for a profile that genuinely carries a property of that
 *     name); a bare allowlisted name means the column; anything else stays a
 *     jsonb key, so no existing flow changed meaning.
 *     Before that, `orderBy: "updatedAt"` looked up a jsonb key no row carries
 *     and returned unordered rows while reporting success — which is why the
 *     old text warned against it. That warning is now obsolete, and leaving it
 *     standing would have been its own bug: the next engineer reads a KNOWN
 *     LIMIT and re-implements a workaround for a limit that no longer exists.
 *     The four gathers therefore order `updatedAt DESC` (see `gatherNode`).
 *   - Filters may now carry a TIME BOUND from the trigger payload, which the
 *     old text also said was impossible. The reason it is safe is specific and
 *     worth stating: for a DATE column an unparseable value (including the ""
 *     a no-payload run produces) is DROPPED with a warning rather than bound.
 *     Dropping WIDENS the result — visible, self-correcting. Binding would
 *     NARROW it to zero rows — invisible, and the narrator would report the
 *     emptiness as a finding. That asymmetry is the whole design, and it is
 *     pinned against the SHIPPED filter strings by
 *     `packages/jobs/src/workers/__tests__/report-flow-filter-safety.test.ts`.
 *     The old warning still holds for a PROPERTY equality filter, where ""
 *     really is a value (`properties->>'projectId' = ''`) — which is why
 *     `projectId`/`focus` still narrow at the interpretation layer, in the
 *     prompts, and NOT in SQL.
 *   - `reportPeriod` and the entity title carry the raw ISO timestamp from the
 *     `compute:now` node. No node in the engine can format a date ("July 2026",
 *     "2026-W30"), and inventing one in an AI round would make the header
 *     non-deterministic. Honest and ugly beats pretty and made up.
 *   - There is no digest-endpoint shortcut: `GET /workspaces/:id/digest` is Hub REST,
 *     and the only node that speaks HTTP (`fetch`) runs behind `validateExternalUrl`
 *     plus needs a service key it has no way to hold. Gather is `query` nodes.
 *   - THE GATHER STAGE CANNOT BE MADE KIND-AGNOSTIC WITH TODAY'S `loop` NODE, and
 *     the four hardcoded gather/project pairs stay. Evaluated 2026-07-27 against
 *     `automation-executor.ts` and rejected on EVIDENCE, not on effort:
 *       · The body itself is fine — `loop` dispatches `query` and `transform` as
 *         child types, and it writes `context.steps[childNode.id]` after each
 *         child, so a per-iteration `transform` does read that iteration's
 *         `query`. `profileSlug` also goes through `resolveTemplate`
 *         (`resolveQueryProfileSlug`), so `{{loop.item}}` as a kind works.
 *       · What breaks is ADDRESSING THE RESULTS. Per-iteration outputs are keyed
 *         `${nodeId}_iter${i}` — by POSITION, never by the kind that produced
 *         them. Nothing carries the iterated item into the result record, and
 *         `delete context.loop` fires before any downstream node runs, so a round
 *         has no way to say "Tasks — N found". `GATHERED_DATA` would have to list
 *         a FIXED number of `_iter0…_iterN` placeholders — reintroducing exactly
 *         the hardcoding the generalization exists to remove, and doing it worse:
 *         with fewer kinds than placeholders the spares resolve to "" and the
 *         round reads that as "nothing found"; with more, the surplus kinds are
 *         dropped and no one is told.
 *       · The plain key is OVERWRITTEN every iteration, so a downstream
 *         `{{steps.project.output.result}}` yields only the LAST kind's rows
 *         while looking like the whole gather. That is the v6 failure verbatim.
 *       · The aggregate `{{steps.<loop>.output.results}}` is not a way out: it
 *         holds one record per CHILD per iteration, including the `query` child's
 *         FULL entity JSON, and it is interpolated (so JSON-stringified) into the
 *         prompt. That is the v4/v5 prompt-cap blowup restored at up to 100
 *         iterations.
 *       · It would also dissolve INTEGRITY_RULE: count and list would come from
 *         one object instead of two independent steps, so they could no longer
 *         disagree — deleting the only in-band signal a round has that its data
 *         was lost in transit.
 *     The unblocker is an ENGINE change, not a flow change: the loop must record
 *     the item alongside each iteration result (and/or key `context.steps` by a
 *     resolved label) so a kind is addressable by NAME downstream. Until then,
 *     four honest hardcoded pairs beat a generic graph that silently reports the
 *     wrong workspace.
 *   - EMBEDS ARE PARTLY BLOCKED, and the v9 text above this line said they were
 *     ENTIRELY blocked. That was wrong, and the shape of the mistake is worth
 *     recording because it is a cheap one to make twice: the investigation
 *     established — correctly — that no `viewId` and no cell `instanceId` can
 *     reach a prompt, and then GENERALIZED from the id-based embeds to ALL
 *     embeds. But a chart cell needs no id. It is CONFIG-ONLY. One true premise
 *     plus one unchecked leap banned a whole capability the report already had.
 *
 *     STILL BLOCKED, for the reason v9 gave, which survives re-verification:
 *       · `executeQueryStep` is hardwired to ONE table. It selects
 *         `.from(entities)` under `eq(entities.type, profileSlug)`
 *         (`packages/jobs/src/workers/automation-executor.ts:2485-2557`), so
 *         `profileSlug` names an entity KIND and nothing else. There is no
 *         table parameter and no second read node.
 *       · Views, cells and automations are NOT entity kinds — each is its own
 *         top-level table: `views` (`schema/views.ts:18`), `cell_instances`
 *         (`schema/cell-instances.ts:59`), `automations`
 *         (`schema/automations.ts:538`). No `query` node can reach any of them.
 *         So `:::synap-view{viewId}` and `:::synap-cell{instanceId}` stay
 *         BANNED: the assembler is not refusing to embed them, it has nothing
 *         to embed them WITH, and a made-up id is a permanent broken block.
 *
 *     NOT BLOCKED, and now allowed under a narrow allowlist — `chart-pie`,
 *     `chart-bar` and `stat-card` (v10 also allowed `chart-gauge`; v11 removed
 *     it, see the version history):
 *       · CHART CELLS ARE SELF-QUERYING. The `chart-*` family and `stat-card`
 *         take only short scalar config — `profileSlug`, `groupBy`,
 *         `aggregation`, `field`, `label`, `timePeriod` — and run their OWN
 *         `trpc.entities.list` at render time. They need no `viewId`, no
 *         `instanceId`, and no data payload in the document. Everything the
 *         assembler must know to emit one is a kind name it already has in
 *         GATHERED_DATA.
 *       · WHAT DECIDES MEMBERSHIP IS THE FAILURE MODE, NOT THE HAPPY PATH.
 *         `cellRefFromLegacy` swallows a `cellProps` JSON parse error and
 *         renders the cell with an EMPTY config (`cell-ref.ts:45-47`), and
 *         these cells declare no `propsSchema`/`defaultProps`, so nothing
 *         validates downstream. This prompt is the ONLY gate. A key may
 *         therefore be prescribed only if its config-less render is VISIBLY
 *         unconfigured (pie/bar: "Pick a group-by property") rather than a
 *         plausible reading (gauge: a workspace-wide "completion" percentage).
 *       · THE ATTRIBUTE CHANNEL IS WIDE ENOUGH. `cellProps` is a string
 *         attribute that `cellRefFromLegacy` runs `JSON.parse` on
 *         (`cell-runtime/src/cell-ref.ts:32-51`, malformed JSON degrades to an
 *         empty config rather than throwing). Verified empirically against the
 *         installed `micromark-extension-directive@4.0.0`: a SINGLE-quoted
 *         attribute value preserves both `"` and `}`; only an UNQUOTED value
 *         terminates early on `}`. The same mixed-quoting form is already the
 *         documented one in `synap-backend/skills/synap/document-embeds.md`
 *         (lines 37-40, 115-121). ASSEMBLE_SYSTEM rule 4 asserted the opposite
 *         — "never inline JSON, never a value containing a double quote or a
 *         `}`" — and that false rule is what made the ban look forced.
 *       · `registerCoreCells` IS REACHED IN `browser/`. The v9 evidence
 *         (`grep -rn "registerCoreCells" browser/` returns NOTHING) was true
 *         and IRRELEVANT: the call is indirect —
 *         `browser/electron/renderer/src/providers/SynapProvider.tsx:23` calls
 *         `registerAllCells()`, which walks `builtinPackages.ts` whose core
 *         package is `{ register: registerCoreCells }` (line 74), synchronously
 *         at boot. `__entity-block` is registered by the same path. A grep for
 *         a symbol is not a check for whether it RUNS.
 *     WHAT WOULD UNBLOCK THE REST — the same engine change v9 named: a read
 *     node that can address a table other than `entities` (a `source`/`table`
 *     discriminator on `query`, or a sibling node type per table) with its own
 *     visibility predicate, since `entityQueryVisibilityWhere` is written
 *     against `entities` columns.
 */

import { getDb } from "../client-pg.js";
import { automations, workspaces } from "../schema/index.js";
import type { FlowDefinition } from "../schema/automations.js";
import { and, eq } from "drizzle-orm";

/** Stable identity of the seeded automation — the reconcile key. */
export const REPORT_AUTOMATION_NAME = "Generate report";

/**
 * Definition version. BUMP THIS whenever `REPORT_AUTOMATION_FLOW` or the
 * description changes, so already-seeded workspaces pick the change up on their
 * next reconcile instead of being frozen at whatever shipped first.
 *
 * v2 — dogfood fix: `summarize` maxTokens 120 → 500. Verified against the live
 * IS that `ai.generate` returns an EMPTY STRING below ~200 tokens (the budget is
 * consumed before the first visible token), so a low cap yields NO answer rather
 * than a short one — and the step still reports success.
 *
 * v3 — dogfood fix from the FIRST real run (run 14c470bc, 2026-07-26), which
 * failed at `assemble` with:
 *   400 {"prompt":["String must contain at most 8000 character(s)"]}
 * The assembler receives BOTH prior rounds' outputs, so the chain's prompt grows
 * with each round's budget: 900 + 800 output tokens ≈ 7-8k chars before framing.
 * Fixed on both sides — the IS `prompt` cap went 8000 → 24000 (it was sized for
 * single-shot calls, not chained flows), AND the upstream budgets came down to
 * 700/600 so the chain does not ride whatever the limit happens to be. A flow
 * whose correctness depends on being just under a cap is not correct, it is lucky.
 *
 * v4 — the ACTUAL root cause of that same run, found by reading the failed
 * steps rather than only the last one: `analyze` and `relate` failed with the
 * SAME 8000-char error, so it was never about chaining. The raw `query` output
 * is full entity JSON, and ~70 sampled rows exceed the cap before any round
 * runs. Added four `transform` projection nodes (gather → project → analyze)
 * that reduce each row to `<id> · <title>`. Prompt size now scales with row
 * COUNT, not with how many properties an entity happens to carry — which is the
 * difference between "works on this workspace" and "works".
 *
 * v5 — the v1 flow was run again with the IS cap already raised to 24000, and
 * `analyze`/`relate` STILL 400'd on it. That settles the argument: raw entity
 * JSON is ~500-1500 chars/row × up to 70 rows, so no cap rescues it and the
 * projection in v4 is the only real fix. Same run surfaced a SECOND bug, fixed
 * here: `summarize`'s prompt was a BARE `{{steps.analyze.output}}`, and
 * `deepResolveTemplates` passes the native value through for a whole-string
 * reference — so a failed upstream round (whose output is `{error: ...}`) handed
 * an OBJECT to a string field and killed this round too. Every other round
 * already embedded its placeholders in surrounding text, which stringifies;
 * `summarize` was the only bare one. It is now wrapped like the rest.
 *
 * RULE going forward: inside a flow, a placeholder that feeds a STRING field is
 * always embedded in text. Bare `{{...}}` is reserved for the cases that must
 * stay native — `entity_create.body`, and array inputs.
 *
 * v6 — the v4/v5 projection nodes were themselves broken, and this is the
 * important one because the failure was SILENT. `{{item.id}} · {{item.title}}`
 * was matched by the engine's whole-string-reference regex `/^\{\{(.+?)\}\}$/`
 * (anchored at both ends, so it backtracks to the LAST `}}`), captured as the
 * junk path `item.id}} · {{item.title`, and resolved to `undefined`. Every
 * projection emitted `[null, null, …]`, so all three AI rounds received empty
 * lists and truthfully reported that the workspace contained no data — while
 * the `query` steps above them had returned 15 notes and 25 tasks, and every
 * step reported SUCCESS.
 * The engine matcher is fixed at its three call sites behind
 * `matchWholeStringReference()`, so no flow change was needed for that. What
 * IS changed here: `guard-assembled` now uses `minLength` instead of `exists`.
 * `exists` is a null check that "" satisfies, so the guard whose message reads
 * "refusing to write an empty report" was doing no such thing — it passed an
 * empty body to the writer, which is why the report rendered "Nothing written
 * yet" on a green run. Two silent failures stacked: one destroyed the data,
 * the other declined to notice.
 *
 * STANDING LESSON: a step that reports SUCCESS while producing nothing is worse
 * than one that throws. Guard the VALUE, not the key.
 *
 * v7 — the four gathers now order by `updatedAt` DESC, so a report reads the
 * work people are actually touching instead of an arbitrary slice.
 * This was previously believed impossible: the header here claimed the `query`
 * node "has NO ordering clause". Half true, and the half that was false was
 * the dangerous half — `orderBy` existed but could ONLY address keys inside
 * the `properties` jsonb. `createdAt`/`updatedAt` are real COLUMNS and are
 * never mirrored into `properties`, so setting `orderBy: "updatedAt"` would
 * have evaluated `properties->>'updatedAt'`, produced NULL for every row, and
 * returned the same arbitrary order as before WHILE APPEARING TO WORK — the
 * third instance of this exact failure mode in one session.
 * So the engine was fixed first (`parseQueryOrderBy` is now a discriminated
 * union: explicit `properties.` prefix ⇒ jsonb, a bare allowlisted name ⇒ the
 * real column, anything else ⇒ jsonb as before), and only then was the flow
 * changed. The prompt copy moved with it: claiming "a SAMPLE, not ordered"
 * would now be false, and a prompt that misdescribes its own evidence is how
 * an honest model reaches a wrong conclusion.
 *
 * v8 — two capabilities the engine grew this session, both wired so that the
 * NO-PAYLOAD run is byte-for-byte what v7 did.
 *
 * (a) PRESENTATION IS NOW DECLARABLE BY THE GENERATOR. `entity_create` accepts
 * `config.systemData`, so the flow that WRITES a report can also say how that
 * report should be PRESENTED, instead of every report of every shape being
 * forced through whatever the `report` profile's default renderer happens to be.
 * The stamp is `systemData.renderer = {kind:"cell", cellKey}` — `kind:"cell"` is
 * the only variant `resolveEntityRendererOverride` honours, deliberately, since
 * `url`/`iframe-srcdoc` are arbitrary-content vectors.
 * DECISION: it stamps the PAYLOAD, not `entity-detail-report-slides`. Two
 * reasons, and the second is the load-bearing one. First, the user asked for the
 * generator to be ABLE to override, not for the default to move; scroll stays
 * the default and a no-payload run produces a report that renders exactly as it
 * did yesterday. Second, AT THE TIME OF WRITING THE SLIDES CELL WAS NOT
 * REGISTERED — `grep` found `entity-detail-report` in
 * `registerWorkspacePersonalizationCells.ts` and found NO
 * `entity-detail-report-slides` anywhere. (That is no longer true: both keys are
 * registered now, and `entity-detail-report-slides` opens in the deck — so
 * `renderer: "entity-detail-report-slides"` in the payload is a working stamp
 * rather than a bet. The reasoning below is kept because it still explains why
 * the key comes from the payload and not from a hardcode.) Seeding a cellKey
 * into every workspace's automation on the bet that a cell lands later is
 * precisely how this file earned its version history. A payload-driven key needs
 * no bet: the flow ships the mechanism, and whoever knows the cell exists names it.
 * Safe by CONSTRUCTION, not by hope: with no payload the key resolves to "" and
 * `resolveEntityRendererOverride` returns null for a zero-length `cellKey`
 * (renderer-runtime/src/index.ts:355, covered by its own test), so the override
 * layer falls through to the profile default. An empty stamp is a NO-OP, not a
 * broken renderer.
 *
 * (b) THE GATHERS ARE NOW TIME-BOUNDABLE. `query` filters address real
 * `entities` COLUMNS through the same `QUERY_COLUMNS` allowlist the v7 ordering
 * fix introduced, so `updatedAt >= <date>` is finally expressible in SQL rather
 * than being begged for in a prompt. The KNOWN LIMIT above says a payload must
 * never be wired straight into `filter` because an empty string is treated as a
 * real value — that remains true for jsonb keys and is why `projectId` is still
 * interpretation-layer only. It is NOT true for a DATE column: the parser
 * coerces the value first and DROPS a term it cannot parse as a date
 * (`coerceDateFilterValue` → `push()` returns after a warn), and "" fails
 * `value.trim()`. So the no-payload run drops the term and reads unfiltered,
 * identically to v7 — the failure direction is WIDER results, which is visible,
 * never zero rows, which is not. The prompt copy moved with it for the same
 * reason it did in v7: the rounds are now told what window they are looking
 * through, so they cannot mistake a bounded gather for the whole workspace.
 *
 * NOT done, and stated so the next reader does not re-derive it: making the
 * gather stage kind-agnostic via a `loop`. It is expressible in the body and
 * unaddressable downstream — full evidence in KNOWN LIMITS at the top.
 *
 * v9 — THE REPORT WAS PURE PROSE. Verified in production against a 706-entity
 * workspace: the flow gathered real data and wrote true, well-sourced prose that
 * NAMED people, companies and tasks — and linked not one of them. Every id was
 * in the prompt. Nothing was clickable. For a product whose whole claim is that
 * a report is a live surface over your graph rather than a text file about it,
 * that is not a polish gap; it is the differentiator missing.
 *
 * Three causes, all prompt-side, all fixed here.
 *
 * (a) THE ROUND THAT WRITES MOST OF THE BODY WAS NEVER TAUGHT THE SYNTAX.
 * `ANALYZE_SYSTEM` said "Output PLAIN PROSE … no directives" and never mentioned
 * chips. A `[[entity:id|label]]` marker is not a directive, but a model told
 * "plain prose, no directives" has every reason to read it as "no markup" — and
 * did. Only `relate` had a chip instruction, and it is the shorter round. The
 * ban is now stated precisely (`no ::: directive blocks`) and the chip grammar
 * is taught to both rounds through ONE shared `CHIP_RULE`.
 *
 * (b) THE ONE ROUND THAT WAS TAUGHT WAS TAUGHT A DEAD FORM. `RELATE_SYSTEM` said
 * `[[<kind>:<id>|<label>]]`, which invites `[[task:…]]` and `[[company:…]]`.
 * Those chips RENDER — the presentation pass in `message-parser/src/parser.ts`
 * is kind-agnostic by design and rewrites any kind word to `<kind>://<id>` — but
 * BOTH report renderers gate navigation on `kind === "entity"`
 * (`ReportScrollRenderer.tsx:340`, `ReportSlidesRenderer.tsx:217`). So the
 * instruction as written produced chips that look clickable and do nothing,
 * which is worse than plain text: plain text does not lie about what it is.
 * `CHIP_RULE` prescribes `entity` for all four gathered kinds — correct, not a
 * workaround, since tasks/notes/people/companies are all rows in `entities` and
 * the chip's job is to OPEN the record, not to announce its kind.
 *
 * (c) THE ASSEMBLER WOULD HAVE ERASED THEM ANYWAY. It is told "you add no new
 * facts", and a formatter obeying that instruction has no reason to preserve
 * markup it did not author — it tidies. Chips are now declared CONTENT, to be
 * copied through verbatim, with the reason stated so the rule survives a reread.
 *
 * ALSO REMOVED: the invitation to embed. `ASSEMBLE_SYSTEM` taught the full
 * `:::synap-view` / `:::synap-cell` syntax and was then handed nothing to put in
 * one — a vocabulary with no nouns, whose only reachable outcome was an invented
 * id and a permanently broken block. It is now told, in the same breath as the
 * syntax, not to emit those two. This is a DOCUMENTED GAP, not a fix: views and
 * cells are separate tables and the `query` node reads `entities` only, so no id
 * for them can physically reach a prompt. Full evidence, and what the engine
 * would need, in KNOWN LIMITS at the top. Stating the limit beats shipping a
 * prompt that quietly hallucinates its way around it.
 *
 * The flow GRAPH is unchanged — no new nodes, no new edges, no new placeholders.
 * v9 is prompts only, which is exactly why the seed version has to move: the
 * prompts are the product here, and they are duplicated per workspace.
 *
 * v10 — v9's EMBED BAN RESTED ON A FALSE PREMISE, and this reverses it under an
 * allowlist. Two of the three facts v9 used to justify "the report cannot embed
 * anything" do not hold:
 *
 * (a) `ASSEMBLE_SYSTEM` rule 4 said attributes must be "short bare values,
 * never inline JSON, never a value containing a double quote or a `}`". That is
 * simply not what the parser does. Checked against the INSTALLED
 * `micromark-extension-directive@4.0.0`: a single-quoted attribute value carries
 * `"` and `}` through intact; only an UNQUOTED value ends at the first `}`. The
 * rule stated a real constraint (unquoted values are fragile) as a universal
 * one, and in doing so removed the ONLY channel a config-only cell has. It is
 * now written as the constraint that actually exists, with a worked example.
 *
 * (b) The renderer evidence was a grep that answered the wrong question.
 * "`grep -rn "registerCoreCells" browser/` returns NOTHING" is true, and the
 * function still runs at boot: `SynapProvider.tsx:23` calls `registerAllCells()`
 * → `builtinPackages.ts:74` → `registerCoreCells`. Absence of a symbol is not
 * absence of a call path. Full correction in KNOWN LIMITS at the top.
 *
 * WHAT V10 ALLOWED (v11 drops `chart-gauge` — see below): `:::synap-cell` for
 * `chart-pie`, `chart-bar`,
 * `chart-gauge` and `stat-card` only, configured through `cellProps` over a kind
 * this flow actually gathered. Those cells are SELF-QUERYING — they take scalar
 * config and issue their own read at render time — so the report needs no id it
 * cannot obtain and carries no stale data payload. This is the differentiator
 * v9 went looking for and concluded was unreachable: a report that is a live
 * surface over the graph rather than prose about it.
 *
 * WHY AN ALLOWLIST AND NOT THE CATALOG — stated so nobody reads the short list
 * as an oversight. Twelve `chart-*` keys are registered, and the four here are
 * the ones whose config is fully derivable from a kind plus at most one property
 * name. The rest need a `valueField`, a `timePeriod` or a numeric axis the
 * assembler would have to GUESS, and a guessed field renders an empty chart that
 * looks authoritative — the same launder-the-emptiness failure INTEGRITY_RULE
 * exists to catch. Separately, VERTICAL SIZING INSIDE THE MARKDOWN WRAPPER IS
 * UNVERIFIED: nobody has yet looked at a rendered report containing one of these
 * blocks, so a chart could come out zero-height or dominate the page. Four keys
 * is a bet small enough to eyeball and reverse. Widen only after a real report
 * has been looked at — and that check is the explicit prerequisite for a v11.
 *
 * The flow GRAPH is again unchanged — prompts only, no new nodes, no new edges,
 * no new placeholders.
 *
 * v11 — V10'S ALLOWLIST WAS JUDGED ON THE HAPPY PATH. Both keys fixed here
 * rendered a confident number that was not what it claimed, which is the same
 * failure INTEGRITY_RULE was written for — arriving this time through the
 * EMBEDS rather than through the prose.
 *
 * (a) THE "SAFE FALLBACK" WAS THE WRONG NUMBER. Rule 9(b) told the assembler
 * that when it was unsure of a property it could fall back to `stat-card` with
 * `aggregation: "count"`, "which needs nothing but profileSlug". That
 * fallback was the most likely cell in any report, and it was wrong every time.
 * `StatCardWidget` reads `config?.timePeriod ?? "week"` (:341) — ALWAYS truthy,
 * there is no "all time" — and for a count it then filters to entities CREATED
 * inside that window (:369-383). So the prescribed config rendered "tasks
 * created in the last 7 days" under the label "Tasks". Nobody reading the
 * report could tell; a number carries more authority than the sentence beside
 * it, and this one was authoritative about a fact it had not measured.
 * FIXED by making the prescription state its own window: `timePeriod` is now
 * MANDATORY in the emitted config and the label must name the window. Removing
 * `stat-card` was the alternative and was rejected — the honest version is
 * expressible from the prompt alone, and a count-per-week is a real thing a
 * report wants to show. "week" is the prescribed default because it is what the
 * widget already computes (so this changes the LABEL, not the figure) and
 * because the count runs over ONE `entities.list` page (limit 500, createdAt
 * DESC): the shortest window is the one most likely to fit entirely inside that
 * page and therefore to be exact.
 *
 * (b) `chart-gauge` IS OFF THE ALLOWLIST. Not because its happy path is wrong —
 * it is fine — but because its FAILURE path is invisible. `cellRefFromLegacy`
 * swallows a `cellProps` JSON parse error and hands the cell an empty config
 * (`cell-ref.ts:45-47`), and none of these cells declare a `propsSchema` or
 * `defaultProps`, so nothing downstream validates what the model emitted. With
 * no config, `chart-pie`/`chart-bar` render "Pick a group-by property" — the
 * reader SEES that nothing was measured. With no config, `chart-gauge` queries
 * every entity in the workspace, defaults `aggregation` to "completion", and
 * draws a percentage that looks exactly like a real reading.
 *
 * STANDING LESSON, and the reason this is a version bump rather than a tweak:
 * THE READER HAS NO ALLOWLIST. This prompt is the only gate between a model's
 * guess and a rendered figure, so a cell key earns its place by what it does
 * when the model gets it WRONG — not by what it does when the model gets it
 * right. Judge the failure mode. A missing chart is strictly better than a
 * confident wrong number.
 *
 * The v10 note above said the rest of the catalog was excluded because those
 * cells "need a valueField, a timePeriod or a numeric axis the assembler would
 * have to GUESS". That test was right and was applied to the wrong list:
 * `stat-card` needed a `timePeriod` too, and quietly guessed one for us.
 *
 * The flow GRAPH is again unchanged — prompts only, no new nodes, no new edges,
 * no new placeholders.
 *
 * v12 — THE REPORT HAD NO HEADLINE, AND NOBODY NOTICED BECAUSE THE DECK MADE
 * ONE UP. Top finding of a UI review of the rendered output, and the cause is
 * one line this file never wrote.
 *
 * (a) NO ROUND EMITTED A `##`, ANYWHERE. `ANALYZE_SYSTEM` and `RELATE_SYSTEM`
 * forbid headings — correctly, the assembler is the only round that formats —
 * and `ASSEMBLE_SYSTEM` was simply never asked for one. It was told to open
 * with a `# ` title above the first section and nothing about the sections
 * themselves. So every `::::synap-section` reached the readers untitled, and
 * each degraded in its own way:
 *   · THE DECK invented a title from the section ATTRIBUTES. `segmentSlides`
 *     fell back to `titleFromSectionAttributes`, which returns
 *     `Capitalize(round) · agent` — "Analyze · analyst" — and the deck set that
 *     as the largest text on the slide, directly above a 12px attribution row
 *     printing the SAME round chip and the SAME agent name. Headline and
 *     metadata said one thing in two sizes, 12px apart, and neither said what
 *     the section had found. The segmenter was not wrong; it was doing the best
 *     possible job with the only strings it had.
 *   · THE SCROLL READER had no section headings at all — one unbroken column of
 *     prose with nothing to scan.
 * FIXED at the source rather than in either renderer: new rule 10 requires every
 * section to OPEN with a single `## <one-line claim>` stating WHAT IT FOUND —
 * "Half the open tasks are blocked", never "Analysis" or "Analyze round", which
 * is the same pipeline vocabulary the deck was already inventing and would have
 * changed nothing. Under 10 words, no trailing period, no markup inside it. The
 * worked example carries the `##` in BOTH sections, including the FAILED one —
 * the case a model is most likely to read as exempt. The segmenter now PREFERS
 * that heading and keeps the attribute-derived label as its fallback, so reports
 * already written under seed ≤ v11 read exactly as they did
 * (`markdown-engine/src/renderer/sections.ts`).
 *
 * (b) CHARTS WERE ALLOWED TO ARRIVE BEFORE THE CLAIM THEY EVIDENCE. v10/v11
 * settled WHICH cells may be emitted and left WHERE and WHAT THEY SAY entirely
 * open. Three rules close it: at most ONE per section and never at the top —
 * a chart that opens a section makes the reader decode a graphic to learn what
 * the section is about, which is the delay the new `##` exists to remove; the
 * `label` must state the finding, because `ChartPieCell.tsx:15` defaults it to
 * "Distribution" and `ChartBarCell.tsx:35` to "Breakdown", so an omitted label
 * is a WRONG heading that looks deliberate rather than a missing one; and if
 * the adjacent sentence already gives the number, the chart is dropped.
 *
 * (c) A CHART IS A LIVE VIEW AND THE PROSE IS A SNAPSHOT — now stated to the
 * assembler, which had never been told. The very property that makes these
 * cells embeddable at all (self-querying, no id, no data payload) means they
 * re-measure when the report is OPENED, possibly weeks after the sentence
 * beside them was written. So a quoted count and a chart of the same data WILL
 * eventually disagree, and the reader cannot tell which is stale. Only the
 * prose can be wrong — the chart is re-measured every render — so the prose is
 * what stops quoting: the chart carries the number, the sentence carries the
 * claim.
 *
 * STANDING LESSON: WHEN A READER INVENTS A TITLE, THE GENERATOR FORGOT TO WRITE
 * ONE. The defect looked like a deck-layout problem — duplicated text, wrong
 * type sizes — and two renderers could have been patched around it forever.
 * Both symptoms came from a single absent `##`. Fix the surface that OWNS the
 * artifact, not the ones that display it.
 *
 * The flow GRAPH is again unchanged — prompts only, no new nodes, no new edges,
 * no new placeholders.
 *
 * v13 — THE CONTRACT PASS. Four defects, all proven from ONE real run
 * (1ec13e8d-d92c-4446-a909-1f433b2ed368, status `completed`) by reading the
 * node inputs and outputs rather than the rendered report. Every one of them
 * shipped GREEN: nothing errored, every step succeeded, and the artifact was
 * wrong anyway. This version changes what the rounds are CONTRACTUALLY given
 * and forbidden, not how eloquent they are told to be.
 *
 * (a) EVERY COUNT IN THE REPORT WAS FABRICATED. The gathers returned
 * `count: 25` (tasks), `15` (notes), `15` (people), `15` (companies). The prose
 * claimed "23 tasks", "Ten notes", "Sixteen people", "Fourteen companies" —
 * four for four wrong, in both directions, including one number LARGER than
 * anything gathered. The cause is structural, not a lapse: the exact counts sat
 * mid-line inside a prose paragraph ("Tasks — 25 found: <150 lines>"), so the
 * cheapest way for a model to answer "how many people?" was to eyeball the list
 * it had just read. A model asked to count will count.
 * FIXED by making the counts a SEPARATE, LABELLED, AUTHORITATIVE block that
 * arrives BEFORE the data (`COUNTS_BLOCK`), plus `COUNT_RULE` — every number in
 * the output must be COPIED from that block, never derived. Structure first,
 * instruction second: the instruction alone was already implied by
 * EVIDENCE_RULE ("never invent counts") and did not hold.
 *
 * (b) `analyze` WAS HANDED NO QUESTION, AND SAID SO IN THE REPORT. Its prompt
 * opened with three blank STEER lines and its output literally began "The STEER
 * lines are empty, so I will produce a broad general read covering all gathered
 * kinds evenly." That sentence is the pipeline's internal vocabulary printed in
 * a document a human reads. The cause is this file's own copy: the user prompt
 * carried "(may be empty — an empty line means no steer was given)" and "Time
 * window (may be empty — an empty value means NO time bound was applied…)".
 * Those are INSTRUCTIONS about the input, and they were placed in the CONTENT
 * channel, so the model treated them as material to account for.
 * FIXED by moving both explanations out of the user prompt and into the system
 * side (`SILENCE_RULE`), leaving the user prompt carrying VALUES only. An empty
 * default is now silent by construction rather than by request.
 * STANDING LESSON: anything in the prompt that explains the prompt will end up
 * in the output. Explanations belong in `system`; the user turn holds data.
 *
 * (c) `relate` RECEIVED A BYTE-IDENTICAL PROMPT TO `analyze` AND RETURNED "".
 * The two system prompts differ, but the USER prompts were the same STEER block
 * and the same GATHERED DATA, and the only thing distinguishing the round was a
 * bare "ANALYST'S READ:" header. It ran 6.1s, produced an empty string, and the
 * report rendered "This section is missing" at 20% confidence — a whole section
 * of every report, empty.
 * The round is KEPT rather than removed, because the distinct task is real and
 * expressible: `analyze` reads each kind, `relate` reads ACROSS kinds. What was
 * missing was ever saying so. Three changes: the user prompt now carries an
 * explicit TASK block naming the cross-kind job (so the two prompts can no
 * longer be identical), `RELATE_SYSTEM` forbids re-describing volume and status
 * (the analyst's job) and requires at least one sentence naming what was
 * checked when no pattern is found — an empty output is no longer a permitted
 * outcome — and `maxTokens` goes 600 → 700 to match `analyze`, the round that
 * demonstrably emits. That last one is evidence, not superstition: v2 recorded
 * that `ai.generate` returns an EMPTY STRING when the budget is consumed before
 * the first visible token, and 600 is the only round budget below the one that
 * worked in the same run.
 *
 * (d) THE DATA WAS NAMES ONLY, AND WAS DESCRIBED AS UNTRUSTWORTHY. Every record
 * reached the rounds as `<id> · <title>` — no status, no dates, no properties —
 * while the copy above it said "this is a SAMPLE, not an ordered or exhaustive
 * listing", UNCONDITIONALLY, even when the gather had returned everything there
 * was. A round given only names and told its input is a sample has exactly one
 * honest output available: a census. That is what it wrote, and it was blamed on
 * the model.
 * FIXED on both halves. The projections now carry KIND-SPECIFIC FIELDS chosen
 * from the profile's real property defs (`ensure-system-profiles.ts`) —
 * status/priority/due for tasks, email/last-interaction for people,
 * industry/location for companies, `updatedAt` for all four. An unset field
 * renders as an empty value, which is a finding the rounds are told they may
 * report. And truncation is now DERIVED rather than asserted: `count` is
 * `results.length` (automation-executor.ts:2624), so `count === limit` is the
 * only truncation signal that exists — the caps are stated beside the counts
 * (from ONE `GATHER_LIMITS` map, so the prompt cannot claim a cap the node does
 * not use) and the rounds are told that below-cap means COMPLETE.
 *
 * (e) ENTITY REFERENCES — verified, already satisfied, strengthened by one word.
 * Checked what the renderer supports before writing anything: the inline
 * `[[entity:<id>|<label>]]` chip is the form both report renderers navigate on
 * (they gate on `kind === "entity"`), and `:::synap-entity{id="…"}` is ALSO
 * real — registered in `markdown-engine/src/renderer/directive-registry.ts:11`
 * and handled at `renderer/index.tsx:96` (`EntityCardEmbed`). The chip form was
 * already required by `CHIP_RULE` (v9) and is what makes a named record live,
 * so (e) needed no new syntax; `CHIP_RULE` (5) is tightened from "link a record
 * the first time it carries weight" to a MUST on first mention.
 * `:::synap-entity` is deliberately NOT prescribed: its failure mode is the one
 * this file keeps paying for — an unclosed `:::` swallows the remainder of the
 * section (rule 2), so a mis-emitted card silently DELETES prose, whereas a
 * mis-emitted chip degrades to literal text the reader can see. No new markup
 * for a capability the chips already deliver.
 *
 * The flow GRAPH is once again unchanged — no new nodes, no new edges. The
 * projection EXPRESSIONS changed (they carry fields now) and `relate` gained an
 * instruction and 100 tokens; no new placeholders reach a new step.
 *
 * ── v14 (2026-08-03) — `analyze`/`relate` maxTokens 700 → 2000 ───────────────
 *
 * DOGFOODED, run of 2026-08-03 15:26. `analyze` failed in 10.1s (not a timeout)
 * with `finishReason=length`, `promptTokens=5776`, `completionTokens=701`, and
 * ZERO visible output; `relate` failed identically (6177 → 700). `assemble`
 * completed in the SAME run at `maxTokens: 2000`, spending 376 completion
 * tokens with `finishReason=stop`.
 *
 * The number is derived, not guessed:
 *   · 701 is a LOWER BOUND on what `analyze` needs and nothing more — the round
 *     was cut off mid-reasoning, so the real requirement is unmeasured and
 *     strictly greater. Any value picked "just above" an unmeasured bound is a
 *     guess wearing evidence's clothes.
 *   · Those rounds are asked for ~250-300 visible tokens on top of that hidden
 *     reasoning, and none of the 701 was visible.
 *   · The trigger was v13 itself: the per-kind projections grew the user prompt
 *     to 15,917 chars, and a richer prompt makes a reasoning model reason
 *     LONGER. Every future prompt improvement pushes the same ceiling again, so
 *     the budget must carry headroom rather than fit today's measurement.
 *   · A higher ceiling costs NOTHING when reasoning is cheap — `assemble` proves
 *     it, sitting at 2000 and spending 376. Tokens are billed on what is used;
 *     `maxTokens` is a truncation point, never a length control. Brevity belongs
 *     in the prompt, which is the same lesson v2 recorded when `summarize` went
 *     120 → 500.
 *   · 2000 is therefore the value, because 2000 is the CEILING: both
 *     `aiGenerateParams` (builtin-verbs.ts) and the IS route (tools-v1.ts) cap
 *     `maxTokens` at 2000. There is no headroom above it to choose. If a future
 *     run reports `finishReason=length` at 2000, the fix is those two schemas —
 *     NOT another nudge in this file.
 *
 * The flow GRAPH is unchanged: no new nodes, no new edges, no new placeholders.
 * Two literals moved. `errorHandling` is untouched — `analyze`/`relate` stay
 * `continueOnError: true` (a failed round is a VISIBLE GAP the assembler
 * renders), and `assemble`/`summarize`/`create-report` stay fail-fast.
 */
export const REPORT_AUTOMATION_SEED_VERSION = 14;

export const REPORT_AUTOMATION_DESCRIPTION =
  "Gather this workspace's state, interpret it over three AI rounds, and write a " +
  "report entity. Run it as-is for a general report, or pass a prompt " +
  '(e.g. "focus on our clients") to steer what it is about.';

// ── Shared prompt fragments ───────────────────────────────────────────────────
//
// THE OVERRIDE MECHANISM, in one place so every round behaves identically:
// each round's user prompt opens with a STEER block whose three lines interpolate
// the trigger payload. With no payload those placeholders resolve to the EMPTY
// STRING (`resolveTemplate` returns "" for a missing path), so the block renders as
// three bare labels — and every system prompt is told, explicitly, that an empty
// steer means "produce a broad general report". With a payload the same three lines
// carry real text and the system prompt is told to treat it as the report's SUBJECT,
// not as decoration: prioritize matching evidence, name what was de-prioritized, and
// say plainly when the gathered data cannot support the steer.

// VALUES ONLY — no parenthetical explaining what an empty line means. That
// explanation used to live right here, in the CONTENT channel, and the model
// duly accounted for it in the report: the v12 output opened "The STEER lines
// are empty, so I will produce a broad general read covering all gathered kinds
// evenly." It was not disobeying; it was answering the only question the prompt
// actually put in front of it. The semantics of an empty line now live in
// SILENCE_RULE, on the system side, where instructions belong.
const STEER_BLOCK = [
  "STEER:",
  "- Prompt: {{trigger.payload.prompt}}",
  "- Focus: {{trigger.payload.focus}}",
  "- Project lens id: {{trigger.payload.projectId}}",
].join("\n");

/**
 * The anti-leak rule. Every round gets it, because every round can leak.
 *
 * THE DEFECT (run 1ec13e8d, 2026-07-31): the `analyze` output began "The STEER
 * lines are empty, so I will produce a broad general read covering all gathered
 * kinds evenly." Pipeline vocabulary — STEER, rounds, gathered kinds — rendered
 * verbatim into a document written for a human who has never heard of any of
 * it, and it arrived at the TOP of the report, which is the position a reader
 * gives the most weight.
 *
 * The fix is two-sided and both sides are needed. STEER_BLOCK stopped carrying
 * the explanation (a self-describing input invites a self-describing output),
 * and this rule states the defaults ONCE, on the system side, so an empty steer
 * and an empty time window are ordinary conditions the model acts on rather
 * than events it reports.
 */
const SILENCE_RULE =
  "NEVER NARRATE YOUR OWN INSTRUCTIONS. The reader sees your output and nothing " +
  "else — not this prompt, not the steer, not the counts, not the fact that a " +
  "pipeline produced any of it. Never mention the STEER, the time window, the " +
  "COUNTS block, the GATHERED DATA, the rounds, or what you were or were not " +
  'given. Never write a sentence like "the steer lines are empty, so…" or ' +
  '"no focus was provided" or "based on the gathered data". ' +
  "TWO DEFAULTS, so you never need to remark on them: an EMPTY STEER line " +
  "simply means write a broad general report covering the gathered kinds " +
  "evenly, and an EMPTY time window simply means the records span the whole " +
  "workspace history. Both are the normal case. Act on them silently and start " +
  "with what you found.";

/**
 * Quantities are DATA, not inference.
 *
 * THE DEFECT (same run): the gathers returned 25 tasks, 15 notes, 15 people and
 * 15 companies. The report said "23 tasks", "Ten notes", "Sixteen people",
 * "Fourteen companies" — wrong four times out of four, once by claiming MORE
 * records than were gathered. Every exact figure was already in the prompt.
 *
 * Why it happened is worth stating, because "tell it not to" was already tried:
 * EVIDENCE_RULE has said "never invent … counts" since v1. The counts were
 * present but positioned as a PREFIX to a 150-line list ("Tasks — 25 found:
 * <lines>"), so at the moment the model needed a number, the nearest available
 * source was the list under its eyes. It counted. Models count badly.
 *
 * So the fix is structural first: COUNTS_BLOCK hoists the figures into their
 * own labelled block ABOVE the data, and this rule makes copying from it the
 * only permitted way to write a number. An instruction guarding a fact the
 * prompt makes inconvenient to reach is a wish, not a contract.
 */
const COUNT_RULE =
  "EVERY NUMBER YOU WRITE MUST BE COPIED FROM THE COUNTS BLOCK. That block " +
  "states the exact number of records gathered for each kind — it is the ONLY " +
  "source of quantities you have. Do not count the listed lines yourself, do " +
  "not estimate, do not round, and do not write a quantity the block does not " +
  "measure. Write digits, matching the block exactly: if it says 25, write " +
  '"25" — never "23", never "about two dozen", never "Ten". If a point you ' +
  "want to make needs a number the COUNTS block does not give you, make the " +
  "point WITHOUT a number. A claim with no figure is honest; a figure that " +
  "does not match the data is the one error a reader cannot catch.";

const STEER_RULE =
  "STEER HANDLING — non-negotiable. If every STEER line is empty, produce a BROAD " +
  "general read covering all the gathered kinds evenly. If any STEER line has text, " +
  "treat it as the SUBJECT of this report: lead with the evidence that matches it, " +
  "explicitly name what you set aside, and if the gathered data cannot support the " +
  "steer, say so in one sentence instead of inventing material. Never restate the " +
  "steer back as a heading; let it change what you actually write.";

const EVIDENCE_RULE =
  "You are interpreting data you did NOT collect. Every claim must trace to a row " +
  "in the GATHERED DATA below. Never invent entities, ids, counts, or dates. " +
  'A step whose value looks like {"error": "..."} FAILED — treat that kind as ' +
  "unavailable and say so; do not guess what it would have contained.";

/**
 * The last line of defense against a silent pipeline fault.
 *
 * WHY THIS EXISTS: on 2026-07-27 a bug in the engine's template matcher made
 * every projection emit `[null, null, …]`. The rounds received empty lists,
 * had no way to know a fault had occurred, and did the reasonable thing —
 * they reported that the workspace contained no data. The pod held 706
 * entities. Nothing errored; the run was green; the output was a confident,
 * well-written, completely false conclusion.
 *
 * That is the failure mode specific to AI-native systems, and it deserves a
 * specific guard. In a conventional app a broken query renders an empty table
 * and the user sees "empty" and doubts it. Here the emptiness gets LAUNDERED
 * into authoritative prose. Fail-soft plumbing plus a fluent narrator equals
 * fabrication, even though no component lied.
 *
 * So each kind now carries its own row COUNT, taken from the `query` step
 * rather than from the projection — two independent sources for the same
 * fact. When they disagree, the round is told to report the disagreement
 * instead of interpreting it. The model becomes a fault DETECTOR rather than
 * a fault NARRATOR, which is the only role it can honestly hold over data it
 * did not fetch.
 */
const INTEGRITY_RULE =
  "DATA INTEGRITY CHECK — do this BEFORE interpreting anything. Each kind below " +
  "states how many records were found, then lists them. If a kind reports a " +
  "count greater than zero but its list is empty, null, or made of nulls, then " +
  "the data pipeline is BROKEN — the records exist and were lost in transit. " +
  "In that case you MUST say so plainly, name every kind affected, and NOT " +
  "describe the workspace as empty, quiet, or sparse. Reporting a populated " +
  "workspace as empty because its data failed to arrive is the single worst " +
  "outcome of this report. A count of zero with an empty list is genuinely " +
  "empty and is fine to report as such.";

/**
 * How a round turns a gathered id into a CLICKABLE chip — shared, because the
 * rule is identical for every round and the one round that had its own copy got
 * it subtly wrong.
 *
 * THE DEFECT THIS FIXES (observed 2026-07-28 on a 706-entity workspace): the
 * report came out as pure prose. It NAMED people, companies and tasks as plain
 * text and linked none of them, even though every id was sitting in the prompt.
 * Two causes, both here. `ANALYZE_SYSTEM` was never taught the syntax at all —
 * it was told "no directives", which an honest model reads as "no markup" — and
 * it is the round that produces most of the report's body. And `RELATE_SYSTEM`,
 * the only round that WAS taught, was taught `[[<kind>:<id>|<label>]]`, which
 * invites `[[task:…]]` / `[[company:…]]`. Those PARSE and RENDER — the
 * presentation pass in `message-parser/src/parser.ts` is deliberately
 * kind-agnostic and rewrites any kind word to `<kind>://<id>` — but both report
 * renderers gate navigation on `kind === "entity"`
 * (`browser/electron/renderer/src/cells/ReportScrollRenderer.tsx:340`,
 * `ReportSlidesRenderer.tsx:217`). So a `task` chip looks live and does nothing.
 * An affordance that renders as clickable and isn't is worse than plain text:
 * plain text tells the reader the truth.
 *
 * Hence `entity` is prescribed for ALL FOUR gathered kinds, and it is CORRECT
 * rather than a workaround: tasks, notes, people and companies are all rows in
 * the `entities` table — `type` discriminates them, and the chip's job is to
 * open the entity, not to name its kind. (`person` also resolves, since the
 * parser aliases it to the `entity://` scheme at parser.ts:125; `entity` is
 * prescribed anyway so there is ONE form to get right.)
 *
 * The id/label constraints are the parser's, not stylistic: the reference regex
 * captures the id as `[^\]|:]+` and the label as `[^\]]*`, so a `:` or `|` in the
 * id, or a `]` in the label, silently fails to match and the raw `[[…]]` renders
 * as literal text.
 */
const CHIP_RULE =
  "LINK THE RECORDS YOU NAME. Every line of GATHERED DATA is `<id> · <title>`. " +
  "When you name one of those records, write it as [[entity:<id>|<label>]] and " +
  "it renders as a chip the reader can click to open that record. Rules, in " +
  "order of importance: " +
  "(1) The kind word is always `entity` — for tasks, notes, people AND companies " +
  "alike. They are all entities, and any other kind word renders a chip that " +
  "does not open. " +
  "(2) Use only an id that appears VERBATIM in the gathered data. Copy it; never " +
  "construct, shorten, complete or guess one. " +
  "(3) If you are unsure of an id, write the plain label with no brackets. A " +
  "wrong id is a dead chip, and a dead chip is worse than plain text. " +
  "(4) The label is free text but must not contain `]`; the id must not contain " +
  "`:` or `|`. A marker breaking either rule renders as raw literal text. " +
  "(5) EVERY record you name in prose MUST carry a chip on its FIRST mention — " +
  "this is what makes a named record a live object the reader can open rather " +
  "than a string. Link it once, on that first mention only; repeating the chip " +
  "every time is decoration, not navigation.";

// ── The gathered-data block every AI round receives, verbatim ────────────────
// PROJECTED, not raw. The FIRST real run (2026-07-26) failed at every AI round
// with `400 prompt: String must contain at most 8000 character(s)` — the raw
// `query` output is full entity JSON (id, type, all properties, timestamps,
// provenance), so ~70 sampled rows blow any sane prompt cap on their own. This
// is not a chaining problem and raising the cap does not fix it; a bigger
// workspace would simply blow the bigger cap.
// So each gather is projected through a `transform` node to one compact line
// per row. That keeps the ids the rounds need in order to emit
// `[[kind:id|label]]` chips, drops everything they never read, and makes prompt
// size scale with ROW COUNT instead of with property count.
// v13 widened the line from `<id> · <title>` to a FIXED, kind-specific set of
// fields (see `projectionNode`). The bound is preserved because the field list
// is enumerated per kind rather than being the whole `properties` bag — the
// line grows by a known constant, not by whatever the entity happens to carry,
// which is the distinction the 8000-char failure above turned on.
// The COUNT comes from the `query` step and the LIST from the `project` step —
// deliberately two different steps, so the pair can disagree. That disagreement
// is the only in-band signal a round has that its data was lost in transit; see
// INTEGRITY_RULE. Reading both from the projection would make them agree even
// when both are wrong, which is exactly the failure that shipped.

/**
 * Per-kind row caps, in ONE place because the number is now stated TWICE — to
 * the `query` node as `limit`, and to the rounds as the cap beside the count.
 *
 * The two must agree, and this is not bookkeeping pedantry: `count` is
 * `results.length` (`automation-executor.ts:2624`), so `count === limit` is the
 * ONLY signal in the whole pipeline that a gather was truncated. If the prompt
 * claims a cap the node does not use, that signal inverts — a complete gather
 * gets described as truncated, or worse, a truncated one gets described as
 * complete. Two hand-kept copies of a number that must be equal is how that
 * happens, so there is one copy.
 */
const GATHER_LIMITS = {
  tasks: 25,
  notes: 15,
  people: 15,
  companies: 15,
} as const;

/**
 * The authoritative quantities, hoisted ABOVE the data and labelled as the only
 * source of numbers. See COUNT_RULE for the defect: these figures were already
 * in the prompt in v12 and were wrong in the output four times out of four,
 * because they sat as a prefix to a long list and the list was the easier
 * thing to count.
 *
 * The cap is stated beside each count so TRUNCATION IS DERIVABLE rather than
 * asserted. v12 told every round, unconditionally, that its input was "a
 * SAMPLE, not an ordered or exhaustive listing" — which was FALSE whenever a
 * kind returned fewer rows than its cap, i.e. most of the time. Telling a model
 * its evidence is untrustworthy when it is in fact complete does not make the
 * model careful; it removes every claim it could honestly make except a census,
 * which is exactly the report that came back.
 */
const COUNTS_BLOCK = [
  "COUNTS — the exact number of records gathered for each kind. These figures",
  "are measured, not estimated, and they are the ONLY quantities available to",
  "you. Each line also gives the cap the gather was limited to.",
  `- Tasks: {{steps.gather-tasks.output.count}} gathered (cap ${GATHER_LIMITS.tasks})`,
  `- Notes: {{steps.gather-notes.output.count}} gathered (cap ${GATHER_LIMITS.notes})`,
  `- People: {{steps.gather-people.output.count}} gathered (cap ${GATHER_LIMITS.people})`,
  `- Companies: {{steps.gather-companies.output.count}} gathered (cap ${GATHER_LIMITS.companies})`,
  "READING A COUNT AGAINST ITS CAP: a count BELOW the cap means every record of",
  "that kind is listed below — the set is COMPLETE and you may describe it as",
  "such. A count EQUAL to the cap means the gather stopped at the cap and more",
  'records exist that you cannot see — describe that kind as "at least N" and',
  "never as complete, and never claim something does not exist merely because",
  "it is absent from the list.",
].join("\n");

const GATHERED_DATA = [
  COUNTS_BLOCK,
  "",
  "Time window: only records updated on or after {{trigger.payload.since}}",
  "",
  "GATHERED DATA — one line per record, MOST RECENTLY UPDATED first. Each line",
  "is `<id> · <title>` followed by ` · <field>=<value>` pairs carrying that",
  "record's real state. An EMPTY value means the field is not set on that",
  "record — that is a fact you may report (an unset status or a missing due",
  "date is a finding), and never a value to guess at. Recent does not mean",
  "important.",
  "Tasks — {{steps.gather-tasks.output.count}} found: {{steps.project-tasks.output.result}}",
  "Notes — {{steps.gather-notes.output.count}} found: {{steps.project-notes.output.result}}",
  "People — {{steps.gather-people.output.count}} found: {{steps.project-people.output.result}}",
  "Companies — {{steps.gather-companies.output.count}} found: {{steps.project-companies.output.result}}",
].join("\n");

/**
 * Optional time bound, applied in SQL, shared by all four gathers.
 *
 * WHY THIS IS SAFE WHEN THE PAYLOAD IS ABSENT — and why the KNOWN LIMIT that
 * forbids wiring a payload into `filter` does not apply here. That limit is
 * about JSONB keys: `properties->>'projectId' = ''` is a real comparison that
 * matches nothing, so an absent payload would silently empty the report.
 * `updatedAt` is a real COLUMN on the allowlist, and the column path coerces
 * before it compiles: `coerceDateFilterValue("")` fails `value.trim()` and
 * returns undefined, so `parseQueryFilterConditions` DROPS the term with a
 * warning instead of binding `Invalid Date`. Dropping WIDENS the result set,
 * which is visible; binding a broken date narrows it to zero, which is not.
 * The no-payload run is therefore unfiltered — exactly v7's behavior.
 *
 * The same drop covers garbage: `since: "last week"` is not a parseable date,
 * so it is dropped and logged rather than quietly matching nothing. And a
 * `since` containing a double quote breaks `JSON.parse` on this string, which
 * yields no filter at all (`filterObj = undefined`) — degrading to unfiltered,
 * the same safe direction.
 *
 * A STRING, not an object, deliberately: `parseQueryFilterConditions` only runs
 * `resolveTemplate` over the STRING form, so this is the shape in which a
 * placeholder inside a filter is resolved at all.
 */
const SINCE_FILTER = '{"updatedAt": {"$gte": "{{trigger.payload.since}}"}}';

/**
 * One gather node per kind. Extracted because all four differ ONLY in slug,
 * label and cap — the ordering rationale and the time bound are identical, and
 * four hand-maintained copies of the same WHY is how two of them drift.
 *
 * `orderBy: "updatedAt"` is the real column (v7). `updatedAt`, not `createdAt`:
 * a report about "what is going on here" should surface the rows people are
 * actually working, not the rows that happen to be oldest-created.
 *
 * `continueOnError` so one dead read degrades the report instead of killing the
 * run — the assembler is instructed to render the gap.
 */
function gatherNode(
  kind: keyof typeof GATHER_LIMITS,
  profileSlug: string,
  y: number
) {
  // From the SAME map the COUNTS block quotes. See GATHER_LIMITS: `count ===
  // limit` is the only truncation signal that exists, so a cap stated to the
  // rounds that differs from the cap applied to the query inverts it.
  const limit = GATHER_LIMITS[kind];
  return {
    id: `gather-${kind}`,
    type: "query" as const,
    position: { x: 420, y },
    data: {
      label: kind.charAt(0).toUpperCase() + kind.slice(1),
      profileSlug,
      filter: SINCE_FILTER,
      orderBy: "updatedAt",
      orderDir: "desc" as const,
      limit,
      errorHandling: { continueOnError: true },
    },
  };
}

/**
 * One projection node per gather —
 * `entities[] → ["<id> · <title> · <field>=<value> …", …]`.
 *
 * WHY THE FIELDS (v13). Until now every record reached the rounds as `<id> ·
 * <title>` and nothing else. A round handed a list of names can say how many
 * there are and what they are called; it cannot say what is stalled, what is
 * overdue, or which of two kinds is moving — so it wrote a census, and the
 * census was read as the model being uninsightful. It was the only true thing
 * it had the evidence to write.
 *
 * WHY A FIXED LIST PER KIND, and not the whole `properties` bag: the bag is
 * what blew the 8000-char prompt cap in v4, and it would blow it again on any
 * workspace whose entities carry a `description` or a `rawData`. A named list
 * grows the line by a known constant. The slugs come from the profile's real
 * property defs (`ensure-system-profiles.ts`: task 1227-1243, person 1304-1324,
 * company 1340-1350) rather than being guessed — a guessed slug resolves to ""
 * and would read as "this field is unset on every record", which is a false
 * finding rather than a missing one.
 *
 * An ABSENT key is safe by construction: `resolveTemplate` renders a missing
 * path as "" (automation-executor.ts:376-379), so a record without a due date
 * renders `due=` rather than failing. The rounds are told in GATHERED_DATA that
 * an empty value means unset — which is real information, not noise: a task
 * with no status is exactly the kind of thing this report exists to surface.
 *
 * `{{item.updatedAt}}` is a Date and renders as a full ISO string (:383). Ugly
 * and exact — the same call this file has made since v8 on `reportPeriod`,
 * since no node in the engine can format a date and inventing a format in an AI
 * round makes it non-deterministic.
 */
function projectionNode(kind: string, fields: string, x: number, y: number) {
  return {
    id: `project-${kind}`,
    type: "transform" as const,
    position: { x, y },
    data: {
      label: `Project ${kind}`,
      // NB the pipe grammar: `executeTransformStep` splits the expression on the
      // FIRST " | " and then splits the remainder on every "|", so no field
      // fragment may contain a pipe character. All of them are `k={{path}}`.
      expression: `{{steps.gather-${kind}.output.entities}} | map: {{item.id}} · {{item.title}} · ${fields}`,
      errorHandling: { continueOnError: true },
    },
  };
}

// ── Round system prompts ──────────────────────────────────────────────────────

const ANALYZE_SYSTEM = [
  "You are the ANALYST round of a Synap workspace report.",
  "Read the gathered workspace data and say what it MEANS: volume and shape of work,",
  "what is in flight versus stalled, what is well-covered versus thin.",
  // Each record now carries its real state (status, priority, due date, last
  // update), so "what is stalled" is finally answerable from the evidence. In
  // v12 this round was asked that question and given only names, and it did the
  // one thing names support: it counted them. Naming the fields here is what
  // turns the ask into something the data can back.
  "Work from the FIELDS on each record, not just its name: status, priority and",
  "due dates are what distinguish moving work from stalled work, and an unset",
  "field is itself worth reporting. Listing or counting what exists is NOT a",
  "finding — say what the state of it means.",
  INTEGRITY_RULE,
  EVIDENCE_RULE,
  COUNT_RULE,
  SILENCE_RULE,
  STEER_RULE,
  CHIP_RULE,
  // "No directives" used to be the whole formatting instruction here, and it is
  // why this round emitted zero chips: a `[[entity:…]]` marker is not a
  // directive, but a model told "no directives, plain prose" has every reason to
  // read it as "no markup of any kind". The ban is now named precisely — it is
  // about the `:::` container blocks, which belong to the assembler alone.
  "Output PLAIN PROSE — short paragraphs and bullets, with [[entity:…]] chips",
  "inline wherever you name a record. No markdown headings, no ::: directive",
  "blocks, no code fences. Under 300 words. Another round will format this.",
].join("\n");

// WHY THIS ROUND STILL EXISTS (v13). In run 1ec13e8d it received a user prompt
// byte-identical to the analyst's — same STEER, same GATHERED DATA, no task of
// its own beyond a bare "ANALYST'S READ:" header — ran 6.1s and returned "".
// Every report shipped with a dead section at 20% confidence.
// Removing the round was the alternative and was rejected: the distinct job is
// real and stateable in one line — the analyst reads WITHIN each kind, this
// round reads ACROSS them — and nothing else in the flow connects a person to a
// company to a task. What was missing was ever telling it that. So the
// distinction is now enforced in three places at once: this prompt forbids the
// analyst's job, the user prompt carries an explicit cross-kind TASK block (so
// the two prompts can no longer be identical), and "no pattern found" must be
// written out rather than returned as silence.
const RELATE_SYSTEM = [
  "You are the PATTERNS round of a Synap workspace report.",
  "You receive the raw gathered data AND the analyst's read of it. Your job is what",
  "the analyst did NOT do: surface RELATIONSHIPS and things worth attention —",
  "clusters, repeated themes, people or companies that recur across kinds, gaps",
  "where a kind is conspicuously empty, and anything that looks like it needs a",
  "decision. Prefer three sharp observations over ten shallow ones.",
  "YOUR SCOPE IS WHAT CONNECTS RECORDS, not what they individually are. Every",
  "observation you write must involve TWO OR MORE records, or TWO OR MORE kinds:",
  "a name that appears in both a task and a company, work clustered on one",
  "person, a due date that lines up with an event, a kind that is empty while a",
  "related kind is busy. Do NOT re-describe volume, status distribution or how",
  "busy the workspace is — that is the analyst's section and repeating it makes",
  "yours redundant. Do not summarise or restate the analyst's read.",
  "NEVER RETURN AN EMPTY ANSWER. If you genuinely find no cross-kind pattern,",
  "write one or two sentences naming what you looked for and did not find (for",
  "example: no person recurs across the tasks and companies gathered). That is a",
  "real finding and the reader needs it. Silence is not an available outcome.",
  INTEGRITY_RULE,
  EVIDENCE_RULE,
  COUNT_RULE,
  SILENCE_RULE,
  STEER_RULE,
  // Was a bespoke three-line copy of this rule teaching `[[<kind>:…]]`, which
  // produced `[[task:…]]` / `[[company:…]]` chips that render and do not open.
  // Now the shared fragment, so the two rounds cannot drift again.
  CHIP_RULE,
  "Output PLAIN PROSE, under 250 words, with [[entity:…]] chips inline. No",
  "headings, no ::: directive blocks, no code fences.",
].join("\n");

// The assembler is the ONLY round that emits Synap-flavoured markdown, and the only
// place the container syntax is taught. There is no prior art in the codebase for
// this syntax, so the rules and a worked example are stated in full.
const ASSEMBLE_SYSTEM = [
  "You are the ASSEMBLER round of a Synap workspace report. You compose the FINAL",
  "document body in Synap-flavoured markdown. You add no new facts — you arrange,",
  "title, and format what the earlier rounds produced.",
  "",
  // The assembler leaks and mis-counts for the same reasons the other rounds do
  // — it sees the same STEER block, and it writes the title and the section
  // headings, which is where a made-up number is most authoritative. It is the
  // LAST round, so anything it invents ships unchecked.
  SILENCE_RULE,
  "",
  "NUMBERS: you were given no COUNTS block, so you may not originate a quantity",
  "at all. Reproduce a figure ONLY by copying one that already appears in the",
  "round material, digit for digit. Never total, re-count, convert to words, or",
  "put a number in the title or in a ## heading that is not already in the",
  "material beneath it.",
  "",
  "SYNAP MARKDOWN SYNTAX — these rules are absolute:",
  "1. A section is a FOUR-COLON container that must be opened and closed:",
  '   ::::synap-section{agent="analyst" round="analyze" confidence="0.8"}',
  "   ...content...",
  "   ::::",
  "2. Leaf embeds use THREE colons and MUST BE CLOSED with their own ::: line.",
  "   There is NO self-closing form. An unclosed embed swallows every line that",
  "   follows it until the section ends, and that content is LOST. Always write",
  "   the closing ::: immediately after the opening line:",
  '   :::synap-cell{instanceId="..."}',
  "   :::",
  '   :::synap-view{viewId="..."}',
  "   :::",
  '   :::synap-entity{id="..."}',
  "   :::",
  "3. The outer container must always have STRICTLY MORE colons than anything nested",
  "   inside it. Four outside, three inside. If you ever nest a four-colon block in a",
  "   four-colon block the section closes early and the rest of the report leaks out.",
  "4. ATTRIBUTE VALUES MUST BE QUOTED. An UNQUOTED value ends at the first } it",
  "   contains, which silently truncates the attribute — so always quote. Use",
  "   DOUBLE quotes for a plain value, and SINGLE quotes when the value is itself",
  "   a JSON object, so the JSON's own double quotes survive:",
  '   :::synap-cell{cellKey="chart-pie" cellProps=\'{"profileSlug":"task","groupBy":"status"}\'}',
  "   :::",
  '   A single-quoted value may contain both " and } — those are only special to',
  "   an unquoted value. Write the JSON compact, on one line, with no trailing",
  "   comma; malformed JSON renders the cell with empty config.",
  "5. The ONLY section attributes that survive are: id, agent, round, skills,",
  "   confidence, stepRunId, nodeId, status. Anything else is silently dropped.",
  '6. confidence is a 0-1 ratio written as a decimal string, e.g. confidence="0.8".',
  "   Never a percentage.",
  "7. CHIPS ARE CONTENT — COPY THEM THROUGH VERBATIM. The round material you were",
  "   given already contains [[entity:<id>|<label>]] markers. Reproduce every one",
  "   EXACTLY as written: same brackets, same id, same label. Do NOT tidy them into",
  "   plain text, do NOT rewrite or re-case an id, do NOT convert them to markdown",
  "   links. You are told you add no new FACTS; a chip is not a fact, it is the",
  "   earlier round's finding made navigable, and stripping it removes the only",
  "   clickable thing in the report while leaving the prose looking fine.",
  "   You may add a chip ONLY by copying a marker that already appears in the",
  "   material. Never invent an id, and never use a kind word other than `entity` —",
  "   this report is READ-ONLY prose, and either mistake produces a dead chip.",
  "8. NEVER EMIT :::synap-view, AND NEVER EMIT :::synap-cell WITH AN instanceId.",
  "   Both need an id you have not been given and cannot obtain, and a made-up",
  "   reference produces a permanent broken block in a document a human reads.",
  "9. YOU MAY EMIT A CHART :::synap-cell — from this allowlist ONLY, configured",
  "   through cellProps. These cells fetch their own data at render time, so they",
  "   need no id, and they make the report a live surface instead of a text file:",
  // stat-card ALWAYS carries an explicit timePeriod, and the label ALWAYS names
  // that window. Not defensive verbosity — the widget has no "all time" mode:
  // `timePeriod` defaults to "week" and, for `aggregation: "count"`, it filters
  // to entities CREATED inside that window (StatCardWidget.tsx:341, :369-383).
  // So the old prescription — profileSlug + count + a bare kind label — rendered
  // "tasks created in the last 7 days" under the word "Tasks". A figure that is
  // not what it says is exactly what INTEGRITY_RULE exists to prevent, and it
  // reads as MORE authoritative than prose because it is a number.
  // "week" is the honest default rather than month/quarter for a second reason:
  // the widget counts over ONE page of `entities.list` (limit 500, ordered
  // createdAt DESC), so the shortest window is the one most likely to fit
  // entirely inside that page and therefore to be exact.
  '   - :::synap-cell{cellKey="stat-card" cellProps=\'{"profileSlug":"<kind>","aggregation":"count","timePeriod":"week","label":"<Kind> created this week"}\'}',
  // `label` is in BOTH prescriptions, not optional: `ChartPieCell` defaults it
  // to the word "Distribution" (see rule 9(f)), so an omitted label is not a
  // missing heading — it is a wrong one that looks deliberate.
  '   - :::synap-cell{cellKey="chart-pie" cellProps=\'{"profileSlug":"<kind>","groupBy":"<property>","label":"<the finding this shows>"}\'}',
  '   - :::synap-cell{cellKey="chart-bar" cellProps=\'{"profileSlug":"<kind>","mode":"category","groupBy":"<property>","label":"<the finding this shows>"}\'}',
  // chart-gauge WAS on this list in v10 and is deliberately off it now. The
  // reader has NO allowlist of its own — `cellRefFromLegacy` swallows a JSON
  // parse error and hands the cell an EMPTY config (cell-ref.ts:45-47), and
  // these cells carry no propsSchema/defaultProps, so nothing validates. This
  // prompt is the only gate, which means a key earns its place by its FAILURE
  // mode, not by its happy path. Config-less, chart-pie/chart-bar render a
  // visible "Pick a group-by property" placeholder — the reader can see that
  // nothing was measured. Config-less, chart-gauge falls back to
  // aggregation "completion" over EVERY entity in the workspace and draws a
  // confident percentage that is indistinguishable from a real reading.
  "   Rules, all mandatory:",
  "   (a) profileSlug must be one of the kinds gathered for THIS report: task,",
  "       note, person, company. A chart over any other kind is a claim this",
  "       report cannot back — the data was never read.",
  "   (b) groupBy / field must name a property that plausibly exists on that",
  "       kind. If you are not confident one does, use the stat-card line above",
  "       EXACTLY as written — profileSlug, aggregation, timePeriod AND a label",
  "       naming the window. Never drop timePeriod and never label a windowed",
  "       count with a bare kind name: the card counts records CREATED in that",
  '       window, so "Tasks" over a weekly count is a false statement about',
  "       the workspace.",
  "   (c) Close EVERY embed with its own ::: line, per rule 2. An unclosed embed",
  "       swallows the rest of the section.",
  "   (d) EDITORIAL RULE — embed to SHOW what a sentence cannot: a distribution,",
  "       a ratio, a count. Never to decorate. At most 2-3 in the whole report,",
  "       placed inside the section whose prose they support. A chart that merely",
  "       restates the sentence beside it is noise, and noise is worse than",
  "       nothing here. If no gathered kind has a distribution worth showing,",
  "       emit no cells at all — that is a correct report, not a lesser one.",
  // ── (e) PLACEMENT ───────────────────────────────────────────────────────────
  // A chart at the top of a section is the first thing the reader meets, so
  // they must decode a picture before they are told what it is for — the claim
  // arrives last, if at all. AT MOST ONE per section is the same cap read from
  // the reader's side rather than the report's: (d) budgets 2-3 for the whole
  // document, but two charts inside ONE section still bury that section's
  // single claim under a gallery.
  "   (e) AT MOST ONE cell per section, and NEVER at the top of a section.",
  "       Place it immediately AFTER the sentence making the claim it evidences,",
  "       so the reader has the claim before the picture. A chart that opens a",
  "       section makes the reader decode a graphic to find out what the section",
  "       is about, which is the delay the ## heading and the claim sentence",
  "       exist to remove.",
  // ── (f) THE LABEL ───────────────────────────────────────────────────────────
  // The defaults are the argument. `ChartPieCell.tsx:15` reads
  // `(config?.label as string) ?? "Distribution"` and `ChartBarCell.tsx:35`
  // reads `?? "Breakdown"` — so an omitted label is not a MISSING heading, it
  // is a WRONG one that looks deliberate: a word true of every pie chart and
  // every bar chart ever drawn, set in the same type a real finding would use.
  // The dimension is already visible in the slices; the FINDING is the only
  // thing the chart cannot say for itself.
  "   (f) The label must state the FINDING, not the dimension. Write",
  '       label:"Half the open tasks are blocked", never label:"Distribution",',
  '       "Status" or "Tasks by status". Always set label explicitly: with none,',
  '       a pie chart titles itself "Distribution" and a bar chart "Breakdown" —',
  "       words true of every such chart ever drawn, which tell the reader",
  "       nothing they cannot already see in the shapes.",
  // ── (g) THE LIVE-DATA DISAGREEMENT ─────────────────────────────────────────
  // The same self-querying property that makes these cells embeddable at all
  // (no id, no data payload — see KNOWN LIMITS) makes them a LIVE view: they
  // issue their own `entities.list` when the report is OPENED, which may be
  // weeks after the prose was written and against a filtered window the prose
  // never had. A sentence quoting "12 open tasks" beside a chart summing to 9
  // is a report visibly contradicting itself, and the reader has no way to know
  // which number is stale. Only the prose can be wrong here — the chart is
  // re-measured every render — so the prose is what must stop quoting.
  "   (g) A CHART IS A LIVE VIEW, THE PROSE IS A SNAPSHOT. These cells run",
  "       their own query when the report is OPENED, which may be long after",
  "       this text was written — so a sentence quoting a count and a chart",
  "       measuring the same thing WILL eventually disagree, and the reader",
  "       cannot tell which is stale. Never write a specific number in a",
  "       sentence that sits beside a chart of the same data: let the chart",
  "       carry the number and let the sentence carry the claim",
  '       ("most open tasks are stalled at review", not "12 of 19 are stalled").',
  "       And if the sentence already gives the number the chart would show,",
  "       DROP THE CHART — one of them is redundant, and the sentence is the one",
  "       that cannot go stale against itself.",
  "   Everything else this report needs is ::::synap-section containers plus",
  "   [[entity:…]] chips inline.",
  // ── Rule 10: THE SECTION HEADLINE ───────────────────────────────────────────
  // WHY THIS RULE EXISTS. Until v12 no round emitted a `##` anywhere: the two
  // interpretation rounds are forbidden headings (correctly — the assembler is
  // the only round that formats), and the assembler was never ASKED for one. So
  // a section arrived at the readers with no title of its own, and both readers
  // degraded in their own way:
  //   · THE DECK invented one from the section ATTRIBUTES —
  //     `Capitalize(round) · agent`, i.e. "Analyze · analyst" — and rendered it
  //     as the largest text on the slide, directly above a 12px attribution row
  //     printing the SAME round chip and the SAME agent name. The headline and
  //     the metadata said one thing in two sizes, 12px apart, and neither said
  //     what the section found.
  //   · THE SCROLL READER had no section headings AT ALL — an unbroken column
  //     of prose with nothing to scan or link to.
  // One missing `##` caused both. A heading that states the FINDING fixes both
  // at once, which is why the fix belongs here and not in either renderer.
  //
  // "What it found", never "what produced it": "Analysis" and "Analyze round"
  // are the same pipeline vocabulary the deck was already inventing — moving
  // that string from the segmenter into the generator would change nothing.
  // The word count and the no-period rule are typographic: this line is set
  // large in the deck, and a long claim wraps to three lines while a trailing
  // period reads as a stray mark at that size.
  "",
  "10. EVERY ::::synap-section MUST OPEN WITH A ## CLAIM HEADING — its first",
  "    line, before any prose. The heading states WHAT THE SECTION FOUND, not",
  '    what produced it: "## Half the open tasks are blocked", never',
  '    "## Analysis", "## Analyze round" or "## Findings". Under 10 words, no',
  "    trailing period, no markdown or [[entity:…]] chip inside the heading",
  "    itself — put the chip in the prose beneath it. Write exactly one ## per",
  "    section. This heading is the section's title everywhere it is read: the",
  "    slide deck sets it as the slide headline (with no heading it falls back",
  "    to the round and agent names, which the slide already shows underneath),",
  "    and the scrolling reader has no section titles at all without it. A",
  "    section whose heading merely names the round tells the reader nothing",
  "    they cannot already see.",
  "",
  "STRUCTURE: one ::::synap-section per round, in order — analyze, then relate.",
  'Open with a single "# " title line ABOVE the first section, and open each',
  "section with its own ## claim heading per rule 10.",
  "",
  // The assembler adds no facts, so its steer duty is narrower than the earlier
  // rounds': the STEER decides the TITLE and the ORDER, never new content.
  "STEER HANDLING: if the STEER lines are empty, title the report generically",
  '("Workspace report — <period>") and keep the rounds in their given order. If any',
  "STEER line has text, name that subject in the title and lead each section with",
  "the material that answers it. Never add facts the rounds did not give you.",
  "",
  'MISSING ROUNDS: if a round\'s material looks like {"error": "..."} or is empty,',
  'you MUST still emit its section, with status="failed", containing one visible',
  "sentence naming what is missing. NEVER silently produce a shorter report — a",
  "reader must be able to see that a round did not run. A failed section is NOT",
  "exempt from rule 10: give it a ## heading that states what is missing",
  '("## The patterns round produced nothing"), because it still occupies a slide',
  "and still needs a headline.",
  "",
  // The example carries the ## in BOTH sections — including the failed one,
  // which is the case a model is most likely to treat as exempt. A failed
  // section still occupies a slide and still needs a headline; "Analyze ·
  // analyst" over an apology is the exact reading rule 10 exists to prevent.
  // The chart sits AFTER the sentence it evidences, and its label repeats that
  // sentence's claim rather than naming the dimension — the two placement rules
  // 9(e)/9(f) state in prose, shown here so they are not read as advisory.
  "WORKED EXAMPLE of correct output:",
  "# Workspace report — July 2026",
  "",
  '::::synap-section{agent="analyst" round="analyze" confidence="0.8"}',
  "## Most open tasks are stalled at review",
  "",
  "Open tasks are piling up untouched since the sprint opened, and the great",
  "majority are sitting in one status — the oldest is",
  "[[entity:3f2a91c4-7b10-4e55-9c02-8ad1f6e4b2d7|Migrate the billing worker]].",
  "Notes are thin.",
  // The label is a NARROWER finding than the ## above it, deliberately — copying
  // the heading verbatim into the label would teach duplication, which is the
  // defect this whole version exists to remove, reintroduced one level down.
  ':::synap-cell{cellKey="chart-pie" cellProps=\'{"profileSlug":"task","groupBy":"status","label":"Review is where open tasks accumulate"}\'}',
  ":::",
  "::::",
  "",
  '::::synap-section{agent="analyst" round="relate" status="failed" confidence="0.2"}',
  "## The patterns round produced nothing",
  "",
  "This section is missing: the patterns round failed and produced no material.",
  "::::",
  "",
  "Be CONCISE — your entire output must fit in 2000 tokens. Emit ONLY the markdown",
  "document. No preamble, no explanation, no code fences around the whole thing.",
].join("\n");

const SUMMARIZE_SYSTEM = [
  "Write ONE plain sentence, under 200 characters, stating what this report found.",
  "No markdown, no directives, no quotes, no leading label. Just the sentence.",
  'If the material is an error or empty, write exactly: "Report generated with ' +
    'incomplete data."',
].join("\n");

// ── Flow definition ───────────────────────────────────────────────────────────

/**
 * The node graph. Linear in effect (the executor walks it topologically and runs
 * steps sequentially in one worker invocation), but authored as a fan-out/fan-in so
 * the four independent gathers are honestly expressed as independent.
 */
export const REPORT_AUTOMATION_FLOW: FlowDefinition = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 0, y: 200 },
      data: {
        triggerType: "manual",
        label: "Run report",
        config: {},
      },
    },
    {
      id: "now",
      type: "compute",
      position: { x: 200, y: 200 },
      data: {
        label: "Timestamp",
        operation: "now",
      },
    },
    // ── Round 1: GATHER (deterministic, no AI) ────────────────────────────────
    // Four independent reads of real workspace state. Four, and HARDCODED —
    // a `loop` over `trigger.payload.kinds` is expressible in the body and
    // unaddressable downstream; see KNOWN LIMITS at the top of this file.
    gatherNode("tasks", "task", 20),
    gatherNode("notes", "note", 140),
    gatherNode("people", "person", 260),
    gatherNode("companies", "company", 380),
    // ── Projection: raw entity JSON → compact per-record lines ───────────────
    // Without these the AI rounds receive full entity JSON and every round 400s
    // on the prompt cap. See the note on GATHERED_DATA.
    // The FIELDS per kind are the profile's own property slugs (v13) — a report
    // that knows only names can only take a census, which is the report v12
    // produced. Slugs verified against `ensure-system-profiles.ts`; a slug that
    // does not exist on the profile renders "" on every row and would read as
    // "unset everywhere", a false finding rather than a missing one.
    projectionNode(
      "tasks",
      "status={{item.properties.status}} · priority={{item.properties.priority}} · due={{item.properties.dueDate}} · updated={{item.updatedAt}}",
      540,
      20
    ),
    // `note` carries only title/content/tags, and `content` is unbounded prose —
    // the exact thing the projection exists to keep out of the prompt. So a note
    // contributes its recency and nothing else.
    projectionNode("notes", "updated={{item.updatedAt}}", 540, 140),
    projectionNode(
      "people",
      "email={{item.properties.email}} · lastInteraction={{item.properties.lastInteractionAt}} · updated={{item.updatedAt}}",
      540,
      260
    ),
    projectionNode(
      "companies",
      "industry={{item.properties.industry}} · location={{item.properties.location}} · updated={{item.updatedAt}}",
      540,
      380
    ),

    // ── Round 2: ANALYZE ──────────────────────────────────────────────────────
    {
      id: "analyze",
      type: "capability",
      position: { x: 660, y: 200 },
      data: {
        label: "Analyze",
        verbId: "ai.generate",
        verbKind: "read",
        inputMapping: {
          system: ANALYZE_SYSTEM,
          prompt: [STEER_BLOCK, "", GATHERED_DATA].join("\n"),
          // 2000, the schema ceiling — see the v14 note above. At 700 this round
          // burned all 701 completion tokens on hidden reasoning and emitted
          // NOTHING (finishReason=length, 10.1s, 2026-08-03). 701 is a lower
          // bound on the need, not the need; the visible ~250-300 tokens sit on
          // top of it; and v13's richer 15,917-char prompt is what pushed the
          // reasoning over. A ceiling is not a length control and costs nothing
          // unused — `assemble` runs at 2000 and spends 376.
          maxTokens: "2000",
        },
        // A failed round must become a VISIBLE GAP in the report, not an aborted
        // run — the assembler is instructed to render it.
        errorHandling: { continueOnError: true },
      },
    },
    // ── Round 3: RELATE / NOTICE ──────────────────────────────────────────────
    {
      id: "relate",
      type: "capability",
      position: { x: 900, y: 200 },
      data: {
        label: "Patterns",
        verbId: "ai.generate",
        verbKind: "read",
        inputMapping: {
          system: RELATE_SYSTEM,
          // The TASK block is what makes this prompt different from the
          // analyst's. In run 1ec13e8d the two user prompts were byte-identical
          // apart from the "ANALYST'S READ" header, and this round returned "".
          // A round given the same input and no different question has no
          // different answer to give.
          prompt: [
            STEER_BLOCK,
            "",
            GATHERED_DATA,
            "",
            "ANALYST'S READ — already written and already in the report. Do NOT",
            "restate, summarise or re-analyse it. It is here so you do not repeat it:",
            "{{steps.analyze.output}}",
            "",
            "YOUR TASK — cross-kind patterns ONLY. Look for what connects the lists",
            "above: a person who recurs in tasks and companies, work clustered on one",
            "name, due dates that line up, a kind that is empty while a related kind",
            "is busy, a company with people but no tasks. Write only observations",
            "that span TWO OR MORE records or kinds. If there are none, say what you",
            "checked and did not find — never answer with nothing.",
          ].join("\n"),
          // 2000, matching `analyze` — the rounds are budgeted together because
          // they are asked for the same shape of answer over the same data.
          // History: 600 → 700 (v9) because 600 was the only round below one
          // that demonstrably emitted; 700 → 2000 (v14) because 700 then failed
          // the same way `analyze` did — 6177 prompt tokens in, all 700
          // completion tokens spent on hidden reasoning, finishReason=length,
          // zero visible output (2026-08-03). See the v14 note above for why the
          // ceiling rather than another nudge.
          maxTokens: "2000",
        },
        errorHandling: { continueOnError: true },
      },
    },
    // ── Round 4: ASSEMBLE (fail-fast — no body, no report) ────────────────────
    {
      id: "assemble",
      type: "capability",
      position: { x: 1140, y: 200 },
      data: {
        label: "Assemble",
        verbId: "ai.generate",
        verbKind: "read",
        inputMapping: {
          system: ASSEMBLE_SYSTEM,
          prompt: [
            STEER_BLOCK,
            "",
            "Report generated at: {{steps.now.output.result}}",
            "",
            "ANALYZE ROUND MATERIAL:",
            "{{steps.analyze.output}}",
            "",
            "RELATE ROUND MATERIAL:",
            "{{steps.relate.output}}",
          ].join("\n"),
          maxTokens: "2000",
        },
      },
    },
    // The `report` profile carries a `summary` property that the header renders.
    // The assembled body is far too long for it, so one short derived call fills it.
    {
      id: "summarize",
      type: "capability",
      position: { x: 1380, y: 200 },
      data: {
        label: "One-line summary",
        verbId: "ai.generate",
        verbKind: "read",
        inputMapping: {
          system: SUMMARIZE_SYSTEM,
          // The placeholder is WRAPPED in text, deliberately — never bare.
          // `deepResolveTemplates` passes the NATIVE value through when the whole
          // string is one `{{...}}` reference. A failed upstream round records
          // `{error: "..."}` as its output, so a bare reference hands an OBJECT to
          // a field zod requires to be a string, and this round dies with
          // `expected string, received object` — a SECOND failure caused only by
          // the first. Embedding the reference forces stringification, so a failed
          // round arrives as readable text this round can report on.
          // (Observed live 2026-07-26: analyze 400'd, then summarize failed this way.)
          prompt: [
            "Material to summarize (may be an error object if the round failed):",
            "{{steps.analyze.output}}",
          ].join("\n"),
          // 500, NOT the ~120 a one-line summary "needs". DOGFOODED 2026-07-26
          // against the live IS: `ai.generate` returns an EMPTY STRING at
          // maxTokens 20 and 120, a degraded answer at 300, and a correct one at
          // 500. The budget is consumed before any visible token is emitted —
          // the signature of a reasoning model — so a low ceiling does not
          // produce a SHORT answer, it produces NO answer, silently and with a
          // successful step status. Brevity belongs in the prompt, not the cap.
          maxTokens: "500",
        },
        // NO continueOnError, deliberately. `summary` is a STRING property
        // rendered verbatim in the report header, and `{{steps.summarize.output}}`
        // is an exact whole-string placeholder — so `deepResolveTemplates` passes
        // the step output through NATIVELY. With continueOnError a failed round
        // records `{error: "..."}` as its output, and that OBJECT would land in
        // `properties.summary` and render as `{"error":"…"}` to the reader.
        // A report with no summary is fine; a report whose summary is a raw
        // error object is not. Failing the run here is the honest outcome.
      },
    },
    // ── Fail closed before writing ────────────────────────────────────────────
    {
      id: "guard-assembled",
      type: "guard",
      position: { x: 1620, y: 200 },
      data: {
        label: "Body assembled",
        checks: [
          // `minLength`, NOT `exists`. `exists` is a NULL check — "" satisfies
          // it — so the original guard promised "refusing to write an empty
          // report" while letting exactly that through. It shipped, and an
          // empty-string body from `ai.generate` (a documented live behavior,
          // see the maxTokens note below) produced a successful run whose
          // report body read "Nothing written yet".
          // 200 rather than 1: a body shorter than that is not a report, and a
          // loud guard failure is a better outcome than a hollow artifact.
          {
            path: "steps.assemble.output",
            minLength: 200,
            message:
              "The assembler produced no usable body (under 200 characters) — " +
              "refusing to write an empty report.",
          },
          {
            path: "steps.assemble.output.error",
            exists: false,
            message:
              "The assembler round failed — refusing to write a report without a body.",
          },
        ],
      },
    },
    // ── Output ────────────────────────────────────────────────────────────────
    {
      id: "create-report",
      type: "output",
      position: { x: 1860, y: 200 },
      data: {
        label: "Create report",
        outputType: "entity_create",
        config: {
          profileSlug: "report",
          title: "Workspace report — {{steps.now.output.result}}",
          properties: {
            reportPeriod: "{{steps.now.output.result}}",
            generatedAt: "{{steps.now.output.result}}",
            reportStatus: "ready",
            summary: "{{steps.summarize.output}}",
            // Context chips. The renderer tolerates `["label"]` as well as
            // `[{id,kind,label}]`; plain labels are what this flow can honestly
            // assert, since the gather nodes read kinds, not named sources.
            reportSources: ["Tasks", "Notes", "People", "Companies"],
          },
          // The whole string is one placeholder → `deepResolveTemplates` hands the
          // markdown through as a native string, and the entity_create node
          // materializes it into a `documents` row linked via entities.documentId.
          body: "{{steps.assemble.output}}",
          // PRESENTATION, DECLARED BY THE GENERATOR. `entities.system_data` is
          // machine state, never a user-editable property, and
          // `resolveEntityRendererOverride` reads exactly this shape as the
          // highest-precedence per-entity renderer. `kind:"cell"` is the ONLY
          // honoured variant — `url`/`iframe-srcdoc` are arbitrary-content
          // vectors and are rejected at the reader, so this stamp cannot become
          // one however the payload is filled.
          //
          // The key comes from the PAYLOAD, and the default is deliberately
          // nothing: with no payload it resolves to "", the reader returns null
          // for a zero-length cellKey, and the profile default
          // (`entity-detail-report`, which opens in scroll) wins exactly as
          // before. Passing
          // `renderer: "<cellKey>"` when triggering makes THAT report render
          // through THAT cell — one report, one run, reversible through the
          // same door. Nothing is silently flipped for anyone.
          //
          // NOT hardcoded to the slides cell, on purpose. `entity-detail-report-slides`
          // IS registered now (it was not when this was written), so the stamp
          // resolves — but the default staying empty is still the right call:
          // a hardcode would move the default reading for every report in every
          // workspace, and that decision belongs to whoever binds the profile.
          // Seeding an unresolvable
          // cellKey into every workspace is the kind of "it will land shortly"
          // bet the version history above is made of.
          systemData: {
            renderer: {
              kind: "cell",
              cellKey: "{{trigger.payload.renderer}}",
            },
          },
        },
      },
    },
  ],
  edges: [
    { id: "e-trigger-now", source: "trigger", target: "now" },
    { id: "e-now-tasks", source: "now", target: "gather-tasks" },
    { id: "e-now-notes", source: "now", target: "gather-notes" },
    { id: "e-now-people", source: "now", target: "gather-people" },
    { id: "e-now-companies", source: "now", target: "gather-companies" },
    // gather → project → analyze. The projection nodes are what keep the prompt
    // bounded; wiring a gather straight into `analyze` is the bug v4 fixes.
    { id: "e-tasks-project", source: "gather-tasks", target: "project-tasks" },
    { id: "e-notes-project", source: "gather-notes", target: "project-notes" },
    {
      id: "e-people-project",
      source: "gather-people",
      target: "project-people",
    },
    {
      id: "e-companies-project",
      source: "gather-companies",
      target: "project-companies",
    },
    { id: "e-tasks-analyze", source: "project-tasks", target: "analyze" },
    { id: "e-notes-analyze", source: "project-notes", target: "analyze" },
    { id: "e-people-analyze", source: "project-people", target: "analyze" },
    {
      id: "e-companies-analyze",
      source: "project-companies",
      target: "analyze",
    },
    { id: "e-analyze-relate", source: "analyze", target: "relate" },
    { id: "e-relate-assemble", source: "relate", target: "assemble" },
    { id: "e-assemble-summarize", source: "assemble", target: "summarize" },
    { id: "e-summarize-guard", source: "summarize", target: "guard-assembled" },
    {
      id: "e-guard-create",
      source: "guard-assembled",
      target: "create-report",
    },
  ],
};

export interface EnsureReportAutomationResult {
  status: "created" | "updated" | "skipped" | "error";
  message: string;
  automationId?: string;
  error?: string;
}

/**
 * Create the report automation for a workspace if it does not already exist.
 *
 * Idempotent and keyed on (workspaceId, name) — matching `ensureDefaultCommands`'s
 * title-keyed reconcile. A user who edited or deleted their copy is NOT overwritten
 * or resurrected on the next call... except deletion, which does re-seed; that is the
 * same behavior every other `ensure*` door has, and the same tradeoff.
 */
export async function ensureReportAutomation(
  workspaceId: string,
  userId: string
): Promise<EnsureReportAutomationResult> {
  try {
    // INSIDE the try, deliberately. This runs from `workspaces.get` — a hot read
    // path awaited without its own try/catch — so a connection-pool throw here
    // would propagate out and 500 the entire workspace read for every caller.
    // Seeding an automation must never be able to take down reading a workspace.
    const db = await getDb();

    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (!workspace) {
      return {
        status: "error",
        message: `Workspace ${workspaceId} not found`,
        error: "WORKSPACE_NOT_FOUND",
      };
    }

    const existing = await db.query.automations.findFirst({
      where: and(
        eq(automations.workspaceId, workspaceId),
        eq(automations.name, REPORT_AUTOMATION_NAME)
      ),
      columns: { id: true, metadata: true, version: true },
    });

    if (existing) {
      const seededVersion = (
        existing.metadata as { seedVersion?: number } | null
      )?.seedVersion;

      // UPGRADE PATH. A pure skip-if-exists reconcile makes the FIRST prompt bug
      // permanent: ~half this file is prompt copy, the row is duplicated per
      // workspace, and there is no single row to fix. That is unacceptable for a
      // flow whose whole point is being iterated on after reading its output.
      // So: bump REPORT_AUTOMATION_SEED_VERSION whenever the definition changes
      // and every workspace picks it up on its next reconcile.
      //
      // TRADEOFF, stated: this OVERWRITES a user's edits to the seeded flow on a
      // version bump. That is why the version is bumped deliberately and never
      // as a side effect of an unrelated edit. A user who wants a permanent
      // variant should duplicate the automation under another name — a different
      // name is a different reconcile key and is never touched here.
      if (seededVersion === REPORT_AUTOMATION_SEED_VERSION) {
        return {
          status: "skipped",
          message: "Report automation already current",
          automationId: existing.id,
        };
      }

      await db
        .update(automations)
        .set({
          description: REPORT_AUTOMATION_DESCRIPTION,
          flowDefinition: REPORT_AUTOMATION_FLOW,
          // MERGE, never replace. `automations.metadata` is a shared bag —
          // `tags`, `createdVia`, `averageExecutionTime`, plus an open index
          // signature — so `.set({ metadata: { seedVersion } })` silently
          // destroyed everything else on every version bump.
          metadata: {
            ...((existing.metadata as Record<string, unknown> | null) ?? {}),
            seedVersion: REPORT_AUTOMATION_SEED_VERSION,
          },
          // The run ledger stamps `definitionSnapshot: { version, flowDefinition }`
          // per run. Leaving `version` untouched while replacing the flow made a
          // v6 run and a v7 run both report version 1 — the snapshot's FLOW was
          // right, but the number naming it was a lie, which is worse than
          // having no number at all.
          version: (existing.version ?? 1) + 1,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, existing.id));

      return {
        status: "updated",
        message: `Upgraded report automation to seed v${REPORT_AUTOMATION_SEED_VERSION}`,
        automationId: existing.id,
      };
    }

    const [row] = await db
      .insert(automations)
      .values({
        workspaceId,
        createdBy: userId,
        name: REPORT_AUTOMATION_NAME,
        description: REPORT_AUTOMATION_DESCRIPTION,
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: REPORT_AUTOMATION_FLOW,
        metadata: { seedVersion: REPORT_AUTOMATION_SEED_VERSION },
        // `active` so the trigger door will actually run it. There is no schedule,
        // so an active manual automation costs nothing until a human runs it.
        status: "active",
      })
      .returning({ id: automations.id });

    return {
      status: "created",
      message: "Created report automation",
      automationId: row?.id,
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(
      `[ensureReportAutomation] Error seeding report automation for workspace ${workspaceId}:`,
      { error: err.message, stack: err.stack }
    );
    return {
      status: "error",
      message: `Failed to seed report automation: ${err.message}`,
      error: err.message,
    };
  }
}
