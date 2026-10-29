# code-skills

How a CODE skill runs, so you can write one that works on the first approval. Author it with `synap_create_skill` (`code` + `body`); for a single deterministic HTTP call on an installed tool, `synap_create_verb` is simpler and needs no code.

## The wrapper

Your `code` is the BODY of an async function. The runtime wraps it as:

```js
(async function (args, context) {
  /* your code */
})(args, context);
```

- `args`: the run's parameters (what the caller passed to `synap_run_capability`), shaped by your `parameters` schema.
- `context`: `{ userId, workspaceId, agentUserId }`.
- `return` a JSON-serialisable value: it is the run's result. Top-level `await` works.

## Limits

- Memory: 64 MB per run (isolated-vm isolate).
- Time: `timeoutSeconds`, default 30, at most 300. Set it on `synap_create_skill` when the skill waits on a slow provider.
- Only ECMAScript built-ins plus `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `btoa`, `atob`, `structuredClone`. There is NO `fetch`, `crypto`, `require`, `process` or `Buffer`: a skill that names one is refused at save time.

## The host bridges

### `callProvider(tool, method, path, body?, opts?)`

Calls an installed tool's API with ITS credential (you never see the key).

- `tool`: the tool's name, as `synap_list_capabilities` lists it (e.g. `"apify_api"`).
- `method`: `"GET" | "POST" | "PUT" | "DELETE"`.
- `path`: relative to the tool's base URL. If the base URL already ends in a version (`https://api.apify.com/v2`), do NOT repeat it: `"/acts/{actorId}/runs"`, not `"/v2/acts/…"`.
- `opts`: `{ headers?, baseUrlOverride?, multipart? }`.

Returns `{ status, headers, body }` on success, or `{ proposed: true, proposalId }` when the call was filed for review. It THROWS `callProvider failed: …` on a provider or auth failure. Always branch on `proposed` before reading `body`.

A GET runs inline. A POST/PUT/DELETE by an agent is governed: it proposes, UNLESS the tool is one the skill declared in `requiredTools` on `synap_create_skill`. Then the verb's own approval covers it, and the run does not stop for a second review.

### Pod files (`file:url`, `file:bytes`)

Declare a parameter as a pod file in `parameters`: `"video": "file:url"`, `"media": "file[]:url?"`, `"attachments": "file[]:bytes?"`. The caller passes the file entity's id (a list for `file[]`). An agent's run that carries a file always waits for the person's approval.

- `:url`: your code receives a signed https URL to the file. Hand it to the tool as is. It lives 15 minutes for a sync skill and 6 hours for an async one.
- `:bytes`: your code receives a handle (`podfile:…`), not the bytes. Put it in a `callProvider` body sent to a tool the skill declared in `requiredTools`, and the pod sends the file:
  - JSON body: the handle's slot becomes the file's base64 (`{ image: args.photo }`), at most 20 MB of files per call.
  - `opts.multipart: true`: a `multipart/form-data` form. A handle, or a list of handles, under a key becomes file parts of that field. Every other value is a text field: `callProvider("unipile_linkedin", "POST", "/api/v1/posts", { account_id, text, attachments: args.attachments }, { multipart: true })`.
  - A handle works only in the run that received it, and only toward the skill's own required tools. `host.fetch` never sends it.

### `hubProtocol` (reads, as the user)

- `hubProtocol.getEntities({ profileSlug, limit })`: entities of one kind.
- `hubProtocol.search(query, opts)`: search across the pod.
- `hubProtocol.getDocument(documentId)`: one document.

Use the STORED slugs: `synap_define_kind` normalises them (`botScore` becomes `botscore`) and says so in its result.

### `propose.entity({ profileSlug, title, properties?, description?, reasoning?, workspaceId? })`

The governed write-back. Returns `{ status, proposalId, proposedEntityId, message }`. It goes through the same governance as any agent write: it proposes unless a rule lets it apply.

### `secrets.get(ref)` and `host.fetch(url, opts)`

`secrets.get("vault://…")` returns a granted secret, or `null`. `host.fetch` reaches only the hosts in the skill's approved `allowedHosts` and returns `{ ok, status, headers, body }` or `{ error, message }`. Prefer `callProvider` for an installed tool.

## Before the first run

1. The skill is born unapproved: the user approves the `skill/create` proposal. That one approval also turns it on: there is no separate enable step.
2. It can still be off: when the person who approved may not turn verbs on (the approval result says so in `refusals`), or after its code changed (an edit turns it off until approved again). `synap_list_capabilities` then shows it as `blocked: "not_enabled"` with an `enable.url`: hand that link to the user instead of running it.
3. `console.log` goes to the pod log, not to your result: return what you need to see.

## Fixing a code skill

Change it in place with `synap_update_skill` (`id` or `slug`): it takes `code` (the whole new source), `parameters`, `timeoutSeconds` and `requiredTools` (the list replaces the declared set), as well as `body`, `description` and `name`. Never call `synap_create_skill` again under the same name: it is refused with the existing skill's id, because two skills with one name make a run by name ambiguous. A change to what the skill runs (code, parameters, timeout, a tool added) turns it off until the person approves it again: read `synap_list_capabilities` before running it.

## Box scripts (packages, files, Python or Node)

When the work needs packages, files or another language (chart a CSV with pandas, convert a file, scrape with a headless browser), write a BOX script instead: `synap_create_skill` with `executionMode: "box"`, the script in `code` (a whole program, not a function body) and `box: { language: "python" | "node", packages: [{ name, version }], hosts: ["api.example.com"], limits? }`.

- It runs on the person's own computer, in a fresh box per run: no pod access, no secrets, network only to the `hosts` you declare (packages install from their registry first). Pin every package to an exact version.
- Parameters arrive as `/in/parameters.json`; write output files to `/out` (they come back on the run and in the session). Print what you want the person to read: the log is kept.
- `synap_run_capability` QUEUES it and returns `{ status: "queued", boxRunId }`: the run is not finished yet. Its log, files and exit code show on the run (Runs, the session's runs). The person must have turned on "Runs scripts" for one of their computers; otherwise the run is refused with that setting named: tell the person.
- It has no preview: a dry-run answers that it runs only on the person's computer.
- The reviewer approves the code, the packages and the hosts together; changing any of them needs a new approval. A box script cannot be declared `readOnly`.
