## Four things you can build

1. **Views** — named queries + rendering config over entities of a given profile. Kanban of tasks, gallery of articles, calendar of events.
2. **Bento dashboards** — 12-col grid compositions of cells (view-cards, entity-cards, widgets). The Home dashboard is a bento. Workspace landing pages are bentos.
3. **Workspaces** — full lenses with profiles, views, a bento, and seed entities. The biggest building block.
4. **New cell types** (Capability B) — AI can define entirely new rendering cells when no existing widget covers the need. Cells run in a sandboxed iframe. Pod-global cells (no `workspaceId`) are available immediately in all workspaces without a proposal step.

   ```json
   POST /api/hub/cells/define
   {
     "name":           "Burndown Chart",
     "rendererSource": "<!DOCTYPE html>…</html>",
     "typeKey":        "burndown-chart",
     "description":    "Sprint burndown over task completions",
     "defaultSize":    { "w": 8, "h": 6 },
     "deps": {
       "recharts": "2.12.0"
     }
   }
   ```

   - `deps` pins npm packages for the esm.sh import map. Keys are npm package names; values are version strings. Max 30 entries. React 19 is always available — never put it in `deps`.
   - Always `GET /api/hub/widget-definitions` first — if a cell already covers the need, use it. New cell definitions are permanent; only create when genuinely novel.
   - For the full in-frame query/mutate/shell-actions API see the `synap` skill's **ViewFrame Cells** section (or load `synap-ui:SKILL` via `GET /api/hub/skills/system?sections=synap-ui:SKILL`).
