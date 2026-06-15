## View types (16 total, 12 implemented)

Pick one that matches the data's shape AND the user's intent:

| Type             | Implemented | When it fits                                               |
| ---------------- | ----------- | ---------------------------------------------------------- |
| `table`          | yes         | Dense data, many columns, sort/filter heavy                |
| `list`           | yes         | Scan-friendly, compact rows (tasks, notes)                 |
| `grid`           | yes         | Card grid, medium density                                  |
| `gallery`        | yes         | Image-forward cards (articles, bookmarks, products)        |
| `kanban`         | yes         | Status pipelines (tasks by status, deals by stage)         |
| `matrix`         | yes         | 2-axis grid (priority × urgency, effort × impact)          |
| `masonry`/`feed` | yes         | Pinterest-style, mixed-size cards; default for Library     |
| `calendar`       | yes         | Date-indexed data (events, tasks by dueDate)               |
| `flow`           | yes         | Node-edge diagrams (automations, mind maps)                |
| `bento`          | yes         | Mixed composition (a dashboard-in-view)                    |
| `branch_tree`    | yes         | Hierarchical data (project → subtasks, threads → branches) |
| `whiteboard`     | yes         | Free-form canvas                                           |
| `timeline`       | no          | (Defer)                                                    |
| `graph`          | no          | (Defer)                                                    |
| `gantt`          | no          | (Defer)                                                    |
| `mindmap`        | no          | (Defer)                                                    |

Decision: the data has statuses → `kanban`. Dates → `calendar`. Many columns → `table`. Mixed types → `masonry` or `bento`. Full reference in **`view-types.md`**.
