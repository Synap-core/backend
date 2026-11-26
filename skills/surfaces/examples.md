## Examples

| Prompt | Body | Why |
| --- | --- | --- |
| "Show all deals" | View (table on deal) | many records of one kind |
| "Show my deals by stage" | View `pipeline` on deal | the kind declares a lifecycle |
| "What's due this week?" | View (calendar, or a list filtered on the due date) | records with dates |
| "A board of my tasks I can drag between columns" | View (kanban, or pipeline when the kind has a lifecycle) | edit many records |
| "Make a dashboard for my sales" | Bento in the sales space | numbers that change |
| "Make a dashboard for the Fundraising project" | Bento attached to the project | monitor; one object |
| "I want to watch project X every morning" | Bento attached to project X | watched over time |
| "Where do things stand on project X?" | Document (a status read-out with live embeds) | read once |
| "Write a memo about the pricing change" | Document | internal text |
| "Show me a summary comparing my top 5 leads" | Document (internal); an HTML artifact if it goes to a client | mostly text |
| "Pitch deck for investors" | HTML artifact deck attached to the project | outside audience, custom design |
| "A one-pager I can send to a prospect" | HTML artifact | outside audience |
| "Write the Q3 report for the board" | Document, then its HTML artifact | report: markdown first |
| "Brainstorm names with me" | Whiteboard | unfinished thinking |
| "Map how our onboarding steps connect" | Whiteboard | mapping ideas, not records |
| "Turn this whiteboard into slides for Monday" | the same Whiteboard, its artboards played by the presenter | the presenter is a mode, not a body |
| "Make deals look different everywhere" | renderer binding on deal (slot card) | kind-wide look |
| "Make the Posts kind's own dashboard" | renderer binding on post, slot `dashboard` | a kind's page, not one object |
| "Make this deal's page show its email thread on top" | attached surface on that deal | one object, not the kind |
| "Give the Fundraising project an investor radar" | attached Bento with a radar cell | one object, not the kind |
| "Show deals as a funnel chart" | catalog cell `chart-funnel` on a bento or embedded in a document | the catalog has it |
| "A cohort heatmap the catalog does not have" | new Cell type, then place it | new visual unit |
| "Health of my pod: errors, queue, cost" | Bento | monitor and operate |
| "Publish our roadmap on the website" | a Site or an external app over an exposed view | audience outside, live data |
