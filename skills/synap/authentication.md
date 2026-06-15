## Authentication

```
Authorization: Bearer {SYNAP_HUB_API_KEY}
X-Workspace-Id:  {workspaceId}            (optional; also pass in body/query)

Scopes:
  hub-protocol.read   → most GET endpoints
  hub-protocol.write  → all writes AND GET /channels/personal
```
