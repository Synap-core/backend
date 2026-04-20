# Bento recipes — reference

Ready-to-adapt layouts for the most common user asks. Each recipe is a starting point — verify widget kinds against `/widget-definitions` and swap in real IDs before committing.

All coordinates use the 12-column grid. `layout: { x, y, w, h }`.

---

## Recipe: Personal home dashboard

_User asks: "Give me a home dashboard."_

The canonical landing page. What matters today + quick access + recent activity.

```json
{
  "name": "Home",
  "type": "bento",
  "config": {
    "blocks": [
      {
        "id": "h1",
        "kind": "widget",
        "widgetKind": "section-header",
        "layout": { "x": 0, "y": 0, "w": 12, "h": 1 },
        "config": { "title": "Today", "subtitle": "{{date}}" }
      },

      {
        "id": "h2",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 0, "y": 1, "w": 3, "h": 2 },
        "config": {
          "label": "Due today",
          "metric": "count",
          "filter": {
            "profileSlug": "task",
            "properties.dueDate": "today",
            "properties.status": ["todo", "in-progress"]
          },
          "icon": "calendar"
        }
      },

      {
        "id": "h3",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 3, "y": 1, "w": 3, "h": 2 },
        "config": {
          "label": "This week",
          "metric": "count",
          "filter": {
            "profileSlug": "event",
            "properties.startDate": "this-week"
          },
          "icon": "calendar-days"
        }
      },

      {
        "id": "h4",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 6, "y": 1, "w": 3, "h": 2 },
        "config": {
          "label": "Pending review",
          "metric": "count",
          "filter": { "type": "proposal", "status": "pending" },
          "icon": "inbox"
        }
      },

      {
        "id": "h5",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 9, "y": 1, "w": 3, "h": 2 },
        "config": {
          "label": "Captured this week",
          "metric": "count",
          "filter": { "createdAt": "this-week" },
          "icon": "zap"
        }
      },

      {
        "id": "h6",
        "kind": "widget",
        "widgetKind": "view-list",
        "layout": { "x": 0, "y": 3, "w": 6, "h": 5 },
        "config": {
          "profileSlug": "task",
          "primaryField": "title",
          "secondaryFields": ["priority", "dueDate", "projectId"],
          "filters": [
            {
              "property": "status",
              "op": "in",
              "value": ["todo", "in-progress"]
            }
          ],
          "sort": [{ "property": "priority", "direction": "desc" }],
          "limit": 10
        }
      },

      {
        "id": "h7",
        "kind": "widget",
        "widgetKind": "proactive-feed",
        "layout": { "x": 6, "y": 3, "w": 6, "h": 5 },
        "config": { "limit": 8 }
      },

      {
        "id": "h8",
        "kind": "widget",
        "widgetKind": "feed",
        "layout": { "x": 0, "y": 8, "w": 12, "h": 4 },
        "config": { "sources": ["entity.create", "entity.update"], "limit": 20 }
      }
    ]
  }
}
```

---

## Recipe: Project overview

_User asks: "Make me a page for Project X."_

Built around one entity. Shows context + child tasks + documents + activity.

```json
{
  "name": "{{projectName}}",
  "type": "bento",
  "config": {
    "blocks": [
      {
        "id": "p1",
        "kind": "entity",
        "entityId": "{{projectId}}",
        "layout": { "x": 0, "y": 0, "w": 12, "h": 3 }
      },

      {
        "id": "p2",
        "kind": "widget",
        "widgetKind": "view-kanban",
        "layout": { "x": 0, "y": 3, "w": 8, "h": 6 },
        "config": {
          "profileSlug": "task",
          "groupBy": { "property": "status" },
          "filters": [
            { "property": "projectId", "op": "eq", "value": "{{projectId}}" }
          ]
        }
      },

      {
        "id": "p3",
        "kind": "widget",
        "widgetKind": "entity-gallery",
        "layout": { "x": 8, "y": 3, "w": 4, "h": 3 },
        "config": {
          "profileSlug": "file",
          "filters": [
            { "property": "projectId", "op": "eq", "value": "{{projectId}}" }
          ],
          "limit": 6
        }
      },

      {
        "id": "p4",
        "kind": "widget",
        "widgetKind": "feed",
        "layout": { "x": 8, "y": 6, "w": 4, "h": 3 },
        "config": { "entityId": "{{projectId}}", "limit": 10 }
      }
    ]
  }
}
```

---

## Recipe: CRM home

_User asks: "Make me a CRM."_

Pipeline-forward. Deals, contacts, upcoming meetings.

```json
{
  "name": "CRM",
  "type": "bento",
  "config": {
    "blocks": [
      {
        "id": "c1",
        "kind": "widget",
        "widgetKind": "section-header",
        "layout": { "x": 0, "y": 0, "w": 12, "h": 1 },
        "config": { "title": "Pipeline" }
      },

      {
        "id": "c2",
        "kind": "widget",
        "widgetKind": "view-kanban",
        "layout": { "x": 0, "y": 1, "w": 12, "h": 6 },
        "config": {
          "profileSlug": "deal",
          "groupBy": { "property": "stage" },
          "cardFields": ["title", "value", "closeDate", "contactId"]
        }
      },

      {
        "id": "c3",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 0, "y": 7, "w": 4, "h": 2 },
        "config": {
          "label": "Open pipeline",
          "metric": "sum",
          "metricField": "value",
          "filter": {
            "profileSlug": "deal",
            "properties.stage": ["lead", "qualified", "proposal"]
          },
          "format": "currency",
          "icon": "trending-up"
        }
      },

      {
        "id": "c4",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 4, "y": 7, "w": 4, "h": 2 },
        "config": {
          "label": "Closing this month",
          "metric": "count",
          "filter": {
            "profileSlug": "deal",
            "properties.closeDate": "this-month"
          },
          "icon": "clock"
        }
      },

      {
        "id": "c5",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 8, "y": 7, "w": 4, "h": 2 },
        "config": {
          "label": "New contacts (30d)",
          "metric": "count",
          "filter": { "profileSlug": "contact", "createdAt": "last-30-days" },
          "icon": "user-plus"
        }
      },

      {
        "id": "c6",
        "kind": "widget",
        "widgetKind": "view-calendar",
        "layout": { "x": 0, "y": 9, "w": 8, "h": 5 },
        "config": {
          "profileSlug": "event",
          "dateProperty": "startDate",
          "endDateProperty": "endDate",
          "view": "week",
          "filters": [{ "property": "relatedToContact", "op": "exists" }]
        }
      },

      {
        "id": "c7",
        "kind": "widget",
        "widgetKind": "view-list",
        "layout": { "x": 8, "y": 9, "w": 4, "h": 5 },
        "config": {
          "profileSlug": "contact",
          "primaryField": "title",
          "secondaryFields": ["role", "companyId"],
          "sort": [{ "property": "lastInteractionAt", "direction": "desc" }],
          "limit": 12
        }
      }
    ]
  }
}
```

---

## Recipe: Content pipeline

_User asks: "Make me a content creation workspace / dashboard."_

Assumes a `draft` profile exists (extend `article` via `synap-schema`).

```json
{
  "name": "Content Pipeline",
  "type": "bento",
  "config": {
    "blocks": [
      {
        "id": "ct1",
        "kind": "widget",
        "widgetKind": "view-kanban",
        "layout": { "x": 0, "y": 0, "w": 12, "h": 6 },
        "config": {
          "profileSlug": "draft",
          "groupBy": { "property": "status" },
          "columnOrder": ["idea", "writing", "review", "published"],
          "cardFields": ["title", "wordCount", "publishDate"]
        }
      },

      {
        "id": "ct2",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 0, "y": 6, "w": 4, "h": 2 },
        "config": {
          "label": "Published this month",
          "metric": "count",
          "filter": {
            "profileSlug": "draft",
            "properties.status": "published",
            "properties.publishDate": "this-month"
          }
        }
      },

      {
        "id": "ct3",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 4, "y": 6, "w": 4, "h": 2 },
        "config": {
          "label": "Words written this week",
          "metric": "sum",
          "metricField": "wordCount",
          "filter": { "updatedAt": "this-week" }
        }
      },

      {
        "id": "ct4",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 8, "y": 6, "w": 4, "h": 2 },
        "config": {
          "label": "In review",
          "metric": "count",
          "filter": { "profileSlug": "draft", "properties.status": "review" }
        }
      },

      {
        "id": "ct5",
        "kind": "widget",
        "widgetKind": "entity-gallery",
        "layout": { "x": 0, "y": 8, "w": 12, "h": 4 },
        "config": {
          "profileSlug": "article",
          "filters": [
            { "property": "source", "op": "eq", "value": "research" }
          ],
          "imageProperty": "thumbnail",
          "limit": 12
        }
      }
    ]
  }
}
```

---

## Recipe: Reading list

_User asks: "Show me my reading list."_

Simple masonry/gallery + stats.

```json
{
  "name": "Reading",
  "type": "bento",
  "config": {
    "blocks": [
      {
        "id": "r1",
        "kind": "widget",
        "widgetKind": "section-header",
        "layout": { "x": 0, "y": 0, "w": 12, "h": 1 },
        "config": { "title": "To read" }
      },

      {
        "id": "r2",
        "kind": "widget",
        "widgetKind": "entity-gallery",
        "layout": { "x": 0, "y": 1, "w": 8, "h": 8 },
        "config": {
          "profileSlug": "article",
          "filters": [{ "property": "status", "op": "neq", "value": "read" }],
          "sort": [{ "property": "createdAt", "direction": "desc" }],
          "imageProperty": "thumbnail",
          "captionProperty": "domain",
          "limit": 24
        }
      },

      {
        "id": "r3",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 8, "y": 1, "w": 4, "h": 2 },
        "config": {
          "label": "Saved this week",
          "metric": "count",
          "filter": { "profileSlug": "article", "createdAt": "this-week" }
        }
      },

      {
        "id": "r4",
        "kind": "widget",
        "widgetKind": "view-list",
        "layout": { "x": 8, "y": 3, "w": 4, "h": 6 },
        "config": {
          "profileSlug": "article",
          "primaryField": "title",
          "secondaryFields": ["readAt"],
          "filters": [{ "property": "status", "op": "eq", "value": "read" }],
          "sort": [{ "property": "readAt", "direction": "desc" }],
          "limit": 10
        }
      }
    ]
  }
}
```

---

## Recipe: Daily briefing

_User asks: "Every morning show me what matters."_

Minimal. AI-driven. Designed to be scannable in 30 seconds.

```json
{
  "name": "Morning Briefing",
  "type": "bento",
  "config": {
    "blocks": [
      {
        "id": "m1",
        "kind": "widget",
        "widgetKind": "morning-briefing",
        "layout": { "x": 0, "y": 0, "w": 12, "h": 4 }
      },

      {
        "id": "m2",
        "kind": "widget",
        "widgetKind": "view-list",
        "layout": { "x": 0, "y": 4, "w": 6, "h": 5 },
        "config": {
          "profileSlug": "task",
          "primaryField": "title",
          "secondaryFields": ["dueDate"],
          "filters": [
            { "property": "dueDate", "op": "lte", "value": "today" },
            {
              "property": "status",
              "op": "in",
              "value": ["todo", "in-progress"]
            }
          ],
          "limit": 8
        }
      },

      {
        "id": "m3",
        "kind": "widget",
        "widgetKind": "view-calendar",
        "layout": { "x": 6, "y": 4, "w": 6, "h": 5 },
        "config": {
          "profileSlug": "event",
          "dateProperty": "startDate",
          "view": "day"
        }
      }
    ]
  }
}
```

---

## Recipe: Governance dashboard

_User asks: "Show me what my AI has been doing."_

```json
{
  "name": "AI Activity",
  "type": "bento",
  "config": {
    "blocks": [
      {
        "id": "g1",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 0, "y": 0, "w": 3, "h": 2 },
        "config": {
          "label": "Pending proposals",
          "metric": "count",
          "filter": { "type": "proposal", "status": "pending" }
        }
      },
      {
        "id": "g2",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 3, "y": 0, "w": 3, "h": 2 },
        "config": {
          "label": "Auto-approved (24h)",
          "metric": "count",
          "filter": {
            "type": "action",
            "source": "agent",
            "status": "approved",
            "createdAt": "last-24h"
          }
        }
      },
      {
        "id": "g3",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 6, "y": 0, "w": 3, "h": 2 },
        "config": {
          "label": "Agents connected",
          "metric": "count",
          "filter": { "type": "agent", "status": "active" }
        }
      },
      {
        "id": "g4",
        "kind": "widget",
        "widgetKind": "stat-card",
        "layout": { "x": 9, "y": 0, "w": 3, "h": 2 },
        "config": {
          "label": "Entities created (7d)",
          "metric": "count",
          "filter": { "source": "agent", "createdAt": "this-week" }
        }
      },

      {
        "id": "g5",
        "kind": "widget",
        "widgetKind": "proposals-list",
        "layout": { "x": 0, "y": 2, "w": 6, "h": 6 },
        "config": { "status": "pending", "limit": 15 }
      },

      {
        "id": "g6",
        "kind": "widget",
        "widgetKind": "agent-activity",
        "layout": { "x": 6, "y": 2, "w": 6, "h": 6 },
        "config": { "limit": 20 }
      }
    ]
  }
}
```

---

## Composition tips

- **Row-by-row thinking.** Each row is one visual theme. Mixing themes in the same row confuses the eye.
- **Start tall, shrink later.** It's easier to shrink an oversized block than to realize a tight block feels cramped.
- **Use `section-header` between themes.** Readers parse visual separators faster than mental ones.
- **Keep stat-cards together in a strip.** Four stats at 3×2 each = one clean row. Four stats scattered = noise.
- **End with the feed.** Activity feeds work best as the last row — they're where the eye lands for recency.
- **One primary view per bento.** The user should know what the bento is "about" at a glance. If you have two headline views, split into two bentos.
- **Show, don't hide.** Putting the most important info behind a widget that needs interaction is a trap. Top-left gets the most attention — put the answer there.
