# Remote MCP servers — how a pod registers, approves and governs them

Load this before you suggest connecting an external MCP server to a pod, or when a server's tools do not
show up. Every claim here is read from the code: the `mcp_servers` table
(`packages/database/src/schema/mcp-servers.ts`), the settings door (`routers/mcp-servers.ts`), the
capability installer (`services/capabilities/create-from-definition.ts`) and the IS adapter.

### The row

One row per server in `mcp_servers`, scoped to a space (`workspaceId`) or pod-wide (null). `slug` is
lowercase `a-z0-9-`, unique per space; the IS names each tool `mcp_<slug>_<tool>`, so a space's server
overrides a pod-wide one with the same slug.

| Field        | Meaning                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ |
| `transport`  | `http` (needs `url`) or `stdio` (needs `command` + `args`, runs on the IS host)            |
| `auth`       | http only: `{ credentialRef: "vault://<id>", header: "Authorization", prefix: "Bearer " }` |
| `toolPolicy` | `{ default: "governed" or "inline", inline: ["tool_a", …] }`; absent = governed            |
| `approved`   | false by default; the supply-chain gate                                                    |
| `enabled`    | the owner's on/off switch                                                                  |

### Secrets never sit on the row

`auth.credentialRef` points at a vault secret. The pod resolves it server-side on every call (never
cached), sends it to the IS as a header, and the agent never sees it. If it cannot be resolved for the
acting user or agent, the server is skipped and its tools simply do not appear: check the vault grant
before you blame the server.

### Governed by default

- A **governed** tool is never called directly: the IS routes it through the pod (`mcp://<slug>`),
  where the capability gate runs it or files a proposal. For an agent, `proposed` is success.
- An **inline** tool is called directly by the IS. Declare `default: "inline"` only for a server that
  exposes nothing but reads; for a mixed server, list its read tools in `inline`.
- No policy at all means governed. This is deliberate and fail-closed.

### Approval, and when it resets

- Tools reach an agent only when the server is **approved AND enabled** (and, in a channel that keeps
  its own MCP list, only the servers that channel opted into). The list is cached for 30 seconds.
- In the space settings, tab MCP Servers: a space **owner or admin** adds, edits or deletes a server; only the space
  **owner** approves it; a pod-wide server needs a pod admin to add or edit.
- Editing `url`, `command`, `args`, `env` or `transport` in the settings **resets approval** (compared by
  value, so a rename or an enabled toggle does not). Re-approve after re-pointing a server.
- A capability (catalog or `market.install`) may declare `mcpServers[]` with `auth` and `toolPolicy`;
  this is the only door that sets those two today (the settings form does not). Its install is the trust
  decision: it may ship `approved: true`. Re-applying it converges url, auth and policy to the
  template and only ever promotes approval, never revokes it.

### As an agent

You have no tool that registers a server. Propose it: a capability that declares the server (installed
through `market.install`, which files a proposal), or ask the person to add it in the space settings (MCP Servers). Never
ask for the secret in chat; it goes in the vault.

### Network: who must reach the URL

The **IS** opens the connection, not your machine. A `url` must be reachable from where the pod's IS runs.

**An unauthenticated dev MCP is never registered on a public URL.** Storybook's `/mcp`
(`http://localhost:6006/mcp`) and similar dev servers have no auth: reach them only over a private
network or a tunnel the IS is on (an SSH tunnel to a dev pod), keep them bound to loopback otherwise,
and prefer a static artifact (Storybook's `/manifests/components.json`) for agents on a remote pod. If
a server would need to be public to be reached, it needs `auth` first.
