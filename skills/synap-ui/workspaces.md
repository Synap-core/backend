## Creating or proposing a workspace

**Always ask before creating.** Workspaces are big objects with profiles, views, members, bento, and seed data. Commit only after user confirms.

The canonical flow:

1. **Assemble a proposal** (no API call yet):

   ```js
   const proposal = {
     name: "Content Creation",
     description: "Draft, review, and publish articles",
     icon: "pen-tool",
     color: "purple",
     profiles: [                 // reuse system profiles by slug OR include custom ones
       { slug: "article", reuse: true },
       { slug: "draft",   displayName: "Draft", parentSlug: "article",
         properties: [
           { slug: "status", valueType: "string", constraints: { enum: ["idea","writing","review","published"] }, uiHints: { displayAs: "status" } },
           { slug: "wordCount", valueType: "number" },
           { slug: "publishDate", valueType: "date" }
         ]
       }
     ],
     views: [
       { name: "Pipeline", type: "kanban", profileSlug: "draft",
         config: { groupBy: { property: "status" } } },
       { name: "Published", type: "gallery", profileSlug: "article",
         config: { filters: [{ property: "status", op: "eq", value: "published" }] } }
     ],
     bento: { blocks: [ … ] },
     seedEntities: []            // optional
   }
   ```

2. **Show it to the user**. Compact, readable. "Here's what I'd create — 2 profiles, 2 views, a bento. Ship it?"

3. **On yes**, commit through `/api/hub/workspaces`:

   ```json
   POST /api/hub/workspaces
   { "userId": "{userId}", "proposal": { /* the object above */ } }
   ```

   This goes through governance — `workspace.create` is **always** proposal-gated even for agents (see `../synap/governance.md`). Expect `status: "proposed"` and tell the user they'll see it in Proposals.

4. **On no**, don't commit. Offer to adjust.
