## Entity scope (pod-wide vs. workspace-scoped)

Profiles have an `entityScope` that determines where entities of that type live:

- `entityScope: "pod"` — entities are **pod-wide** (home `workspace_id = NULL`). Visible under ACL + role-as-lens facets — **not** exclusive to one app. Good for people, companies, notes, articles, knowledge/lessons — identity and memory that cross contexts.
- `entityScope: "workspace"` — entities live in the workspace they were created in (process kinds). Good for deals, pipelines, workspace-specific artifacts.

**Default is `pod`** (schema column default + write door). Only declare `entityScope: "workspace"` when the kind is a genuine process document that must not float pod-wide.

### Pin ≠ exclusive prison

Filing into a workspace sets a **home pin**, not exclusive ownership. Role facets make the same person visible in CRM (or Operations) without copying the row. Never treat workspace pin as a folder that traps identity.

### Write pins (agents & capture)

- **Omit** `workspaceId` for pod-scope kinds — server placement lands them pod-wide.
- **Ambient / active workspace** is a **list lens** and optional process home, not a silent dump target.
- Process kinds + explicit pin / routed domain home use `resolveKindWritePin` (one rule for capture, import, thought).

If you're creating a profile for something clearly pod-wide (a person, a podcast, a book, a lesson), leave default pod or set `entityScope: "pod"` explicitly. Do **not** set workspace "to be safe" — that reintroduces folder-trap bugs.
