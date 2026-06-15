## Worked example — "Make me a CRM"

1. Inventory. User already has `person`, `contact`, `company`, `deal`, `event` profiles (all system).
2. No new profiles needed. The CRM is a **lens**, not new data.
3. Propose (before committing):
   - Workspace name: "CRM"
   - Views:
     - `Deals Pipeline` — kanban on `deal`, groupBy `stage`
     - `Contacts` — table on `contact`, columns: name, role, company, lastInteraction
     - `Companies` — gallery on `company` (logo-forward)
     - `Upcoming Meetings` — calendar on `event`, filter `relatedToContact`
   - Bento:
     - Top: `deals pipeline` view (8 cols × 4 rows)
     - Side: `stat-card` — "Deals in pipeline: $X" (4 cols × 2 rows)
     - Side: `stat-card` — "Meetings this week: N" (4 cols × 2 rows)
     - Bottom: `recent-activity` widget (12 cols × 3 rows)
4. Show to user. Confirm.
5. Commit via `POST /workspaces`.
