# API keys, scopes and grants

> Verified against code on 2026-10-20 (backend@cc4b2d81).

An API key authenticates a machine caller (an agent, the CLI, an integration)
to a pod. What the key may do is decided in two layers: **scopes** say which
doors it may use, and a **grant** bounds what it may touch through them.

## The key row

`api_keys` (`packages/database/src/schema/api-keys.ts`):

- `key_prefix` (`synap_hub_live_`, `synap_hub_test_`, `synap_user_`),
  `key_hash` (bcrypt) and `key_lookup_hash` (sha256 of the full key, for an
  indexed lookup; legacy rows are backfilled on their first successful bcrypt
  verify). The full key is shown once, at mint.
- `key_type`: `hub_inbound` (default), `user_pat`, `system`, `service`,
  `is_internal`.
  - `service`: a machine credential owned directly by a human, with explicit
    scopes (default `hub-protocol.read`) and bound to one workspace. Minted by
    `POST /api/hub/setup/service`. A second service key for the same owner does
    not revoke the first.
  - `is_internal`: the Intelligence Service's pod-read key, the only type that
    may read on behalf of the operator whose turn it is processing. Minted only
    by the control-plane-signed `POST /api/provision/register-intelligence`; no
    public mint path can set it.
- `scope` (text array), `expires_at`, `is_active`, `last_used_at`,
  `usage_count`, `rotated_from_id`, `rotation_scheduled_at`.
- `parent_key_id`: a child (sub-token) key; see
  [hub-protocol.md](hub-protocol.md#per-user-sub-tokens).
- `workspace_id`: the key is confined to that workspace
  (`resolveConfinedWorkspace`, `routers/hub-protocol/confine-workspace.ts`),
  whatever its type.
- `linked_user_id`: the human an agent key acts for.

## Scopes

`API_KEY_SCOPES` in the same file is the list that can be minted:

| Scope                                           | Door                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `hub-protocol.read`, `hub-protocol.write`       | Hub REST and API-key tRPC                                                                                    |
| `hub-protocol.admin`                            | alias of `hub-protocol.write`; only privileged at mint                                                       |
| `mcp.read`, `mcp.write`                         | `/mcp`                                                                                                       |
| `data.read`, `data.write`                       | aliases accepted on `/mcp` only                                                                              |
| `read:entities`, `write:entities`, `ai:analyze` | n8n integration                                                                                              |
| `providers.write`                               | creating or changing AI providers (it sets where prompts are sent, so it is not in the default agent bundle) |
| `setup.agent`                                   | `POST /api/hub/setup/agent` without the provisioning token                                                   |
| `skills.invoke`, `chat.stream`                  | `/api/external/skills`, `/api/external/chat`                                                                 |
| `realtime:observe`                              | read-only Socket.IO subscription (see [realtime.md](realtime.md))                                            |
| `probe`                                         | writes are marked as probes, hidden and swept                                                                |

The data words `preferences`, `calendar`, `notes`, `tasks`, `projects`,
`conversations`, `entities`, `relations`, `knowledge_facts`, and the scopes
`webhook:manage` and `mcp.connect`, were retired on 2026-10-06 because no door
checked them. Existing rows that carry them keep working; they cannot be minted.

## Grants

A grant (table `grants`, migration `0305_grants.sql`) bounds what a key may
touch: permissions of the form `<subject>[.<kind>].<action>`
(`entity.knowledge.read`, `entity.*.read`, `*`) plus optional workspace, project
and entity sets. The effective right is the grant intersected with what the
human behind the key may do.

- **Grammar:** one pure module, `@synap-core/types/grants`
  (`packages/types/src/grants/grammar.ts`). `packages/governance-policy/src/grants.ts`
  is a byte-identical mirror (it cannot depend on `@synap-core/types` without a
  build cycle), pinned by `grants-mirror.tripwire.test.ts`.
- **Writer:** `GrantRepository` (`packages/database/src/repositories/grant-repository.ts`).
  A key whose grant is revoked or expired resolves to deny-all, never to "no grant".
- **Enforcement:**
  - `resolveKeyIdentity` (`packages/api/src/access/key-identity.ts`) loads the
    grant for all three transports (Hub REST, tRPC, `/mcp`) and runs the request
    inside it;
  - writes: `checkPermissionOrPropose` denies an out-of-grant write first
    (`utils/grant-write-check.ts`);
  - reads: `scopedDb` / `accessScopeWhere` combined with `grantReadPredicate`
    (`access/grant-read.ts`);
  - door fence: a key with a narrowed grant may only read through the doors
    listed in `access/grant-door-fence.ts`; every other read door answers 403
    `GRANT_DOOR_UNSUPPORTED`. To open a door to scoped keys, route its reads
    through `scopedDb` / `accessScopeWhere`, then list it.
- **Access roles** (table `grant_roles`, migration `0307_grant_roles.sql`): a
  person's reusable permission lists, `{ name, description, grant }`. Written
  through `GrantRoleRepository`; tRPC `grantRoles.list/create/update/archive`.
  A role is a template: minting copies its grant and stamps `grants.role_id` for
  lineage, so editing a role never widens an existing key.
- **Agent capabilities** use the same grammar: `agentHasCapability`
  (`packages/governance-policy/src/index.ts`) accepts grant patterns alongside
  the legacy forms, so an agent can be limited to one kind
  (`entity.knowledge.update`).
- The shared model for displaying grants (catalog, presets, `summarizeGrant`,
  `AGENT_GRANT_CATALOG`) is in `packages/types/src/grants/`. The editor UI lives
  in Synap's web client, outside this repository.

## Lifetime, rotation, revocation

- `expiresInDays` omitted: 90 days; a number: that many days; `null`: never
  (`resolveKeyExpiry`).
- tRPC `apiKeys` (`packages/api/src/routers/api-keys.ts`): `create`, `list`,
  `revoke`, `rotate` (mints a new key and revokes the old one), `setGrants`,
  workspace variants (`createForWorkspace`, `listForWorkspace`,
  `revokeForWorkspace`) and pod-admin procedures.
- Every file that mints a key is listed with a reason in
  `packages/api/src/__tripwires__/api-key-mint-sites.test.ts`; a new mint site
  fails CI until it is listed.

## Rules for handlers

- **An agent key acts as its human.** On an agent key `ctx.userId` is the
  linked human, so an owner-only handler must also check `agentUserId`.
- **Attribution is required for writes on `/mcp`.** A bare `user_pat` or
  `hub_inbound` key with no linked user is refused for writes there; agents use
  a real agent key (`synap init`).

## Legacy: the `hub` access-token flow

`packages/api/src/routers/hub.ts` still serves the original flow:
`hub.generateAccessToken` exchanges a key for a JWT valid 60 to 300 seconds, and
`hub.requestData`, `hub.submitInsight` and `hub.semanticSearch` accept that
token. Its scope words (`preferences`, `notes`, ...) are that router's own
vocabulary and unrelated to `API_KEY_SCOPES`. New integrations use the Hub
Protocol REST API with the key directly.

## History

- 2025-01: the first design used long-lived bcrypt keys only to mint
  short-lived JWTs for `hub.requestData`, with data-word scopes.
- 2026-10-06: data-word scopes retired; grants, the door fence, mint-site
  tripwire, 90-day default expiry and access roles introduced. Several
  owner-gated handlers that did not check `agentUserId` were closed the same day.
