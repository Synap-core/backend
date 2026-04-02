# File Upload & Import System

## File Upload

### Concept

Files are entities. Every uploaded file becomes an entity with profile `"file"` and properties:

```typescript
{
  fileName: string;    // "screenshot.png"
  mimeType: string;    // "image/png"
  fileSize: number;    // bytes
  storageKey: string;  // MinIO path: "files/{workspaceId}/{entityId}/{name}"
  width?: number;      // image dimensions
  height?: number;
}
```

No separate `files` table. Uses `entities` + `@synap/storage` (MinIO/R2).

### Upload Endpoint

```
POST /api/files/upload (multipart/form-data)
Authorization: Kratos session cookie

Fields:
  file: binary (max 10MB)
  workspaceId: UUID (required)
  channelId: UUID (optional — auto-links to channel context)

Response:
  { entityId, fileName, mimeType, size, storageKey, previewUrl? }
```

```
GET /api/files/:entityId/url
Authorization: Kratos session cookie

Response:
  { url: "presigned-url", expiresAt: "ISO-8601" }
```

### Chat Attachments

`sendMessage` accepts `attachmentEntityIds: string[]` (max 10). For each:

1. Verifies entity exists with `type="file"`
2. Inserts `channel_context_items` row (relationship: `used_as_context`)
3. Stores `metadata.attachments` on the message as JSONB

### AI Context

The Intelligence Service receives file entities via `getThreadContext()` → `linkedEntities`. For files, `properties` (including `storageKey`, `mimeType`) are included. The IS context-manager:

- Images: generates presigned URL → injects `![fileName](url)` into system prompt
- Documents: injects `[File: name (type, size)]` as text reference
- Cap: 5 file context items per message

### Storage

- **Dev**: MinIO (Docker) at `localhost:9000`
- **Production**: Cloudflare R2 (S3-compatible)
- **Path format**: `files/{workspaceId}/{entityId}/{originalFileName}`
- **Provider**: `@synap/storage` package with `IFileStorage` interface

---

## Data Import

### Endpoint

```
POST trpc/import.submitBatch
Authorization: Kratos session (workspace-scoped)

Input:
  items: Array<{
    path: string           // file path (preserves folder structure)
    contentBase64: string  // base64-encoded content
    mimeType?: string      // optional, auto-detected from extension
  }>

Limits:
  5MB per file, 20MB total, 50 files max
```

### Type Detection & Processing

| Extension | Detection               | Action                                                      |
| --------- | ----------------------- | ----------------------------------------------------------- |
| `.json`   | `detectJsonChatShape()` | Create external_import channel + messages                   |
| `.md`     | `parseMarkdown()`       | Create entity (note) + document with frontmatter properties |
| `.csv`    | `parseCsv()`            | Create entities (one per row, headers as properties)        |
| Other     | —                       | Store raw file in MinIO under `imports/{userId}/{batchId}/` |

### Response

```json
{
  "batchId": "uuid",
  "filesReceived": 10,
  "entitiesCreated": 7,
  "channelsCreated": 1,
  "filesStored": 2,
  "errors": []
}
```

### Frontend: ImportDialog

Available in `@synap/channels` as `<ImportDialog>`. Supports:

- Drag-and-drop files and folders
- `webkitdirectory` for folder selection
- Recursive directory traversal (FileSystemEntry API)
- Auto-type detection with colored badges
- Per-file progress + results summary
- Accessible from ChannelList header (Upload button)

---

## Telegram Notifications

### Push Notifications

When an AI proposal is created, `notifyProposalViaTelegram()` fires (in `permission-check.ts`, fire-and-forget). Sends a Telegram message with inline button linking to the Mini App.

### Morning Digest

`telegram-digest` pg-boss worker runs daily at 8 AM. For each user with a Telegram connection:

- Counts pending proposals
- Counts new entities (last 24h)
- Sends summary via Telegram Bot API
- Includes "Open Synap" inline button

### Bot Token Resolution

`resolveTelegramBotToken()` — 3-tier chain with 5-min cache:

1. Secrets vault (`category='integrations'`, `encryptionMode='server'`)
2. `workspace.settings.controlPlane.telegramBotToken`
3. `process.env.TELEGRAM_BOT_TOKEN`
