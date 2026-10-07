## The intent vocabulary — one SSOT, three mirrors

**What a capability DOES** — `send_message`, `generate_media`, `publish_post`,
`delegate_agent_task` — is the
ROUTING axis over the verb catalog. A verb's id is vendor-keyed (`gmail_send`,
`unipile_send_message`); its `intent` says what it MEANS, so an agent can ask for
"send a message" without already knowing the vendor.

An intent is **routing only, never authorization**. It resolves to a concrete verb id
BEFORE the governance gate, which then decides on the verb exactly as it did before.

### THE SOURCE OF TRUTH IS A TABLE, NOT A UNION

The SSOT is the pod's **`capability_intents` table**. Slugs live in ROWS, not in a
TypeScript union:

```sql
SELECT slug, effect, statement FROM capability_intents ORDER BY slug;
```

| Column      | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| `slug`      | the seat. `^[a-z][a-z0-9_]{0,63}$` (a CHECK constraint)   |
| `effect`    | CLOSED axis a rule may key on: `read` \| `write` \| `act` |
| `statement` | the human sentence                                        |
| `synonyms`  | for FINDING a row, never for identity                     |

This is why every code-side copy is a **mirror** and not the source. A slug that fits
none of the existing rows leaves `intent` UNSET; the vocabulary is deliberately not
open for developers to mint (cf. W3C Web Intents, abandoned partly for that reason).

### The three mirrors, and why each one must exist

There are exactly **three**. A fourth was deleted in 2026-10-01 (see below).

| #   | Where                                                                                                                             | Kind                              | Why it cannot import the SSOT                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `synap-backend/packages/database/src/schema/tools.ts` — `ABSTRACT_VERBS`                                                          | runtime, the 0283 SEED union (13) | `@synap-core/types` **devDepends on** `@synap/database`. A reverse import is a build cycle — the same constraint that forces `GUIDELINE_SCOPE_ORDER` to be mirrored.                                                                                         |
| 2   | `synap-backend/packages/types/src/capability-intents/` — `ABSTRACT_INTENTS`, `REGISTERED_EXTRAS`, `CAPABILITY_INTENTS`            | runtime, published leaf           | Same cycle, other direction. It is a **leaf subpath** (`@synap-core/types/capability-intents`) rather than the `./` barrel because the barrel re-exports `@synap/database` types and a VALUE import from a barrel crashes Hermes (relay ships React Native). |
| 3   | `synap-control-plane-api/src/seeds/capability-intent-vocabulary.ts` — `ABSTRACT_VERBS`, `REGISTERED_EXTRAS`, `CAPABILITY_INTENTS` | runtime, the CP catalog seeder    | The control plane is a **separate deploy target with its own `pnpm-lock.yaml`**. It resolves neither `@synap-core/types` nor the pod's packages (verified: `require.resolve('@synap-core/types')` → `MODULE_NOT_FOUND`).                                     |

Consumed by: `@synap/api` (`intent-registry`, `create-from-definition`,
`schemas/playbook-definition.ts`), `synap-app/packages/workspace-templates`
(`validate.ts` — the `taskIntents` check), and the CP's `seed-capability-templates.ts`.

### Which field on which surface

Search for this chapter by the field you are holding, not by the word "intent":

| Field             | Lives on                                                           | Means                                                                           |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `intent`          | a **skill** in a capability definition; a `ToolVerb` catalog entry | what ONE verb does                                                              |
| `provides`        | a **capability template**                                          | every intent the whole PACK serves — must equal the `intent` its skills declare |
| `taskIntents`     | a **workspace template**                                           | what the SPACE needs the pod to be able to do                                   |
| `requiredIntents` | a **playbook**                                                     | what the PROCESS needs the pod to be able to do                                 |

All four are validated against this ONE vocabulary, so a workspace and a playbook
cannot be spelled from two different lists.

### THE FOURTH MIRROR WAS DELETED — do not re-add it

`AbstractVerb` in `@synap/playbooks/src/index.ts` was a TYPE-only mirror of all 13
slugs. It was **stale** (no `publish_post`) and **dead** — a whole-repo scan across
every repo, `src/`, `dist/`, and generated `.d.ts` found **zero importers**.

A mirror nothing imports and nothing checks is not a mirror: it is a comment that
looks like a contract. `packages/playbooks/src/required-intents.test.ts` now refuses
`AbstractVerb`, `ABSTRACT_INTENTS`, or `REGISTERED_EXTRAS` being re-declared there.

`ToolVerb.intent` is `string`, not a closed union, and must stay that way: a union in
a package that consumes nothing would go stale in the one direction that is invisible.

### Adding a slug — the exact steps

1. **Write the migration.** A new numbered `.sql` in `synap-backend/packages/database/migrations/`,
   `INSERT INTO "capability_intents" ("slug", "effect", "statement") VALUES (...) ON CONFLICT ("slug") DO NOTHING;`
   `effect` ∈ `read|write|act`. Never `drizzle-kit generate` — hand-write it, and mirror it into
   `0000_baseline_schema.sql` if it adds a table or column.
2. **Add it to mirror 1** — `ABSTRACT_VERBS` in `packages/database/src/schema/tools.ts`,
   **only if it is a SEED slug**. A post-seed row does not belong there (that is what
   `publish_post` / `REGISTERED_EXTRAS` is for).
   Post-seed rows today: `publish_post` (0284, write) and `delegate_agent_task`
   (0314, act — every verb of an external-agent binding, `tools.config.agentBinding`:
   start / send / status / cancel).
3. **Add it to mirror 2** — `ABSTRACT_INTENTS` or `REGISTERED_EXTRAS` in
   `packages/types/src/capability-intents/index.ts`. Then **`cd packages/types && pnpm build`** —
   consumers typecheck against the built `dist/`, so a skipped rebuild makes your gate lie.
4. **Add it to mirror 3** — the same two lists in the control plane's
   `capability-intent-vocabulary.ts`.
5. **Update the arity floors** — `SEED_SLUG_ARITY` / `EXTRA_SLUG_ARITY` in
   `packages/api/src/__tripwires__/intent-vocabulary-one-ssot.tripwire.test.ts`.
   These are the ONE place you must edit by hand, and the build stops until you do.

A slug in the table but missing from a mirror is **not silent**: every guard re-derives
from the migration SQL, so it is a red build — never a divergence nobody notices.

### What can still go wrong

- **A mirror can be added.** Nothing structurally prevents a fifth copy; the tripwire
  only polices the names it knows. This is why step 5 exists as a hand-edit floor.
- **A guard proves SAMENESS, never CORRECTNESS.** If every mirror and the migration agree
  on a slug that should not exist, all four guards stay green. The vocabulary's MEANING is
  reviewed by a human, not derived.
- **A new migration file is not auto-scanned.** Each parity guard lists its migration
  filenames. A slug added in `0295_…sql` is invisible to all of them until that list is
  extended — so extending it is part of step 1, not a follow-up.
- **`@synap-core/types` is published.** Mirror 2 ships to npm; changing it without a
  version bump leaves consumers on the old vocabulary.
