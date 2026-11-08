# Discover & fetch

Three doors reach the same catalog. Pick the one that matches where you're
running.

## CLI — `synap market`

```bash
synap market                              # browse/list (the default action)
synap market --search "crm"               # filter by name/description/slug
synap market --type capability            # filter by type: workspace|capability|skill|workflow|view|cell
synap market --search "crm" --type workspace --json
```

`market` with no subcommand lists; `--list` is accepted explicitly too. It
merges: your OWN packages (public + private, via `GET /api/packages/mine`)
with the PUBLIC catalog (`GET /api/packages`) — logged out, you only see the
public/bundled set.

Companion commands:

```bash
synap market installed             # what's already installed on THIS pod (pure read)
synap market installed --tree      # composition graph: package → templates → workspaces
synap market update                # check installed packages for drift against the catalog
```

## Pod verb — `market.search` (MCP / agent / automation)

The pod-native verb, run via MCP `run_capability` or
`POST /api/hub/capabilities/execute` with `{ verbId: "market.search", parameters }`:

```json
{ "query": "crm", "kind": "template", "limit": 20 }
```

- `kind` ∈ `capability | automation | template | cell` (omit to search all).
- Reads the pod-local `cp_catalog_cache` — fast, no live CP round-trip.
- Returns `{ entries: [{ slug, kind, name, description, version, tier, installed }], count }`.
- `installed` is `true`/`false` for capability/cell (cheap natural-key check);
  `undefined` for automation/template — that's an HONEST unknown, not a bug,
  never read it as "not installed."
- Empty result → say so plainly ("nothing matched") — never fabricate a
  package that doesn't exist. Offer to capture the gap as a note for later.

### Where a capability runs

Every capability entry says where it runs, and `synap_find`'s marketplace
matches carry the same fields:

- `runsOn`: `pod`, `computer`, or both.
- For one that runs on a computer: `systems` (the operating systems it
  installs on), `licence`, and `computers`, the person's computers, each
  with `canInstall: true`, or `canInstall: false` and `why` not.

To ask for it, call `synap_request_installation` with its `slug` as
`capabilityKey` and `computer` set to one of `computers` (its name or id)
with `canInstall: true`, or `"pod"` for one that runs on the pod. It files
ONE proposal; when the pod does not have the capability yet, approving it
adds it from the marketplace and installs it on that computer. A refusal
names why and lists `computers` to choose again from. Read the result with
`synap_list_installations` once the computer's worker has run it.

This is the verb an agent should reach for first — it's read-only (auto-runs,
no approval needed) and mirrors exactly what `synap market --search` shows a
human.

## Fetching one package's full definition

- **CLI (authoring path):** `synap market publish --from-workspace <id>` reads
  a LIVE workspace via the pod's own `to-template` serializer — see
  `author-and-publish.md`.
- **CP directly:** `GET /api/packages/:slug` returns the full row **with**
  `definition` — the install payload. Auth is required to see a private
  package (author-only). No auth → public only, and a private slug 404s.
- **From an install:** you don't normally need the definition yourself —
  `market.install` (see `install.md`) resolves and applies it for you.
