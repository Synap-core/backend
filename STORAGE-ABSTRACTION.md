# Storage Abstraction Implementation

**Status**: ✅ Complete  
**Date**: 2025-11-06  
**Purpose**: Enable local-first development with MinIO while maintaining production R2 support

---

## Overview

We've implemented a clean storage abstraction that allows Synap to work seamlessly with:
- **Cloudflare R2** (production, cloud)
- **MinIO** (local development, uses your existing notes folder)

The abstraction uses the **Strategy Pattern** with a factory function to select the appropriate provider at runtime.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              Application Code                           │
│  (NoteService, Jobs, etc.)                             │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ Uses IFileStorage interface
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Storage Factory                            │
│  createFileStorageProvider()                           │
│  - Reads STORAGE_PROVIDER env var                      │
│  - Returns appropriate provider                        │
└────┬───────────────────────────────┬────────────────────┘
     │                               │
     ▼                               ▼
┌──────────────┐            ┌──────────────┐
│ R2Provider   │            │ MinIOProvider│
│ (Production) │            │ (Local Dev)  │
└──────────────┘            └──────────────┘
     │                               │
     ▼                               ▼
┌──────────────┐            ┌──────────────┐
│ Cloudflare R2│            │ MinIO Server │
│ (Cloud)      │            │ (Docker)     │
└──────────────┘            └──────┬───────┘
                                    │
                                    ▼
                            ┌──────────────┐
                            │ ./data/notes │
                            │ (Your files) │
                            └──────────────┘
```

---

## Implementation Details

### 1. Interface (`interface.ts`)

Defines the contract all storage providers must implement:

```typescript
export interface IFileStorage {
  upload(path: string, content: string | Buffer, options?: UploadOptions): Promise<FileMetadata>;
  download(path: string): Promise<string>;
  downloadBuffer(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  getMetadata(path: string): Promise<FileInfo>;
  getSignedUrl(path: string, expiresIn?: number): Promise<string>;
  buildPath(userId: string, entityType: string, entityId: string, extension?: string): string;
}
```

**Key Features**:
- ✅ Provider-agnostic interface
- ✅ All methods return Promises (async)
- ✅ Consistent error handling
- ✅ Type-safe with TypeScript

---

### 2. R2 Provider (`r2-provider.ts`)

Implements `IFileStorage` using Cloudflare R2:

```typescript
export class R2StorageProvider implements IFileStorage {
  // Uses AWS SDK with custom endpoint
  // Endpoint: https://{accountId}.r2.cloudflarestorage.com
}
```

**Configuration**:
- `R2_ACCOUNT_ID`: Cloudflare account ID
- `R2_ACCESS_KEY_ID`: R2 access key
- `R2_SECRET_ACCESS_KEY`: R2 secret key
- `R2_BUCKET_NAME`: Bucket name
- `R2_PUBLIC_URL`: Public URL (optional)

---

### 3. MinIO Provider (`minio-provider.ts`)

Implements `IFileStorage` using MinIO (local S3-compatible server):

```typescript
export class MinIOStorageProvider implements IFileStorage {
  // Uses AWS SDK with MinIO endpoint
  // Endpoint: http://localhost:9000 (configurable)
  // Automatically creates bucket if it doesn't exist
}
```

**Configuration**:
- `MINIO_ENDPOINT`: MinIO server URL (default: `http://localhost:9000`)
- `MINIO_ACCESS_KEY_ID`: MinIO access key (default: `minioadmin`)
- `MINIO_SECRET_ACCESS_KEY`: MinIO secret key (default: `minioadmin`)
- `MINIO_BUCKET_NAME`: Bucket name (default: `synap-storage`)
- `MINIO_PUBLIC_URL`: Public URL (optional, defaults to endpoint)

**Key Features**:
- ✅ Automatically creates bucket on first use
- ✅ Uses path-style addressing (required for MinIO)
- ✅ Reads/writes directly to mounted folder (`./data/notes`)

---

### 4. Factory (`factory.ts`)

Creates the appropriate provider based on environment:

```typescript
export function createFileStorageProvider(): IFileStorage {
  const provider = process.env.STORAGE_PROVIDER || 'r2';
  
  switch (provider.toLowerCase()) {
    case 'r2':
      return new R2StorageProvider({ ... });
    case 'minio':
      return new MinIOStorageProvider({ ... });
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Singleton instance
export const storage = createFileStorageProvider();
```

**Usage**:
```typescript
import { storage } from '@synap/storage';

// Works with any provider!
await storage.upload('path/to/file.md', 'content');
```

---

## Migration Guide

### Before (Direct R2 Usage)

```typescript
import { r2, R2Storage } from '@synap/storage';

const path = R2Storage.buildPath(userId, 'note', entityId, 'md');
const result = await r2.upload(path, content);
```

### After (Interface Usage)

```typescript
import { storage } from '@synap/storage';

const path = storage.buildPath(userId, 'note', entityId, 'md');
const result = await storage.upload(path, content);
```

**Benefits**:
- ✅ Works with R2 or MinIO (no code changes!)
- ✅ Easier to test (mock the interface)
- ✅ Future-proof (add new providers easily)

---

## Local Development Setup

### 1. Start MinIO

```bash
docker-compose up -d minio
```

### 2. Configure Environment

```bash
# .env.local
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY_ID=minioadmin
MINIO_SECRET_ACCESS_KEY=minioadmin
MINIO_BUCKET_NAME=synap-storage
```

### 3. Use Your Existing Notes Folder

```bash
# Place your notes in ./data/notes
mkdir -p data/notes
cp -r ~/Documents/MyNotes/* data/notes/

# MinIO will expose them via S3 API!
```

### 4. Test It Works

```typescript
import { storage } from '@synap/storage';

// Upload
const result = await storage.upload(
  'test/note.md',
  '# Test Note\n\nContent here'
);

// Download
const content = await storage.download('test/note.md');

// File is also in ./data/notes/test/note.md!
```

---

## Production Deployment

### Switch to R2

```bash
# .env.production
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=synap-storage
```

**No code changes needed!** The factory automatically selects R2.

---

## Testing

### Unit Tests

```typescript
// Mock the interface
const mockStorage: IFileStorage = {
  upload: vi.fn(),
  download: vi.fn(),
  // ... other methods
};

const service = new NoteService(db, mockStorage);
```

### Integration Tests

```typescript
// Use MinIO for local testing
const storage = new MinIOStorageProvider({
  endpoint: 'http://localhost:9000',
  // ...
});
```

---

## File Structure

```
packages/storage/
├── src/
│   ├── index.ts              # Main exports
│   ├── interface.ts          # IFileStorage interface
│   ├── factory.ts            # Provider factory
│   ├── r2-provider.ts        # R2 implementation
│   ├── minio-provider.ts     # MinIO implementation
│   └── r2.ts                 # Legacy R2Storage (backward compat)
├── package.json
└── tsconfig.json
```

---

## Benefits

### 1. **Local-First Development**
- Use your existing notes folder
- No cloud dependencies
- Fast iteration

### 2. **Production-Ready**
- Same code works in production
- Just change environment variable
- No code changes needed

### 3. **Testability**
- Easy to mock interface
- Can use MinIO for integration tests
- Isolated unit tests

### 4. **Extensibility**
- Add new providers easily (S3, Azure Blob, etc.)
- Just implement `IFileStorage`
- Update factory function

### 5. **Type Safety**
- Full TypeScript support
- Compile-time checks
- IntelliSense support

---

## Future Enhancements

### Potential Providers

1. **AWS S3**: Direct S3 support (not via R2)
2. **Azure Blob Storage**: Azure integration
3. **Google Cloud Storage**: GCS support
4. **Local Filesystem**: Direct file system (no S3 API)

### Features

1. **Caching Layer**: Add Redis cache for frequently accessed files
2. **CDN Integration**: Automatic CDN URL generation
3. **Versioning**: File versioning support
4. **Encryption**: Client-side encryption before upload

---

## Troubleshooting

### MinIO Not Connecting

```bash
# Check MinIO is running
docker-compose ps minio

# Check endpoint
echo $MINIO_ENDPOINT

# Test connection
curl http://localhost:9000/minio/health/live
```

### Bucket Not Found

```bash
# MinIO auto-creates bucket, but check logs:
docker-compose logs minio

# Manually create:
docker-compose exec minio-client /usr/bin/mc mb local/synap-storage
```

### Files Not Appearing

1. Check folder is mounted: `docker-compose exec minio ls /data`
2. Check bucket name matches: `echo $MINIO_BUCKET_NAME`
3. Check file path: Files should be in `./data/notes/` folder

---

## Summary

✅ **Interface-based design** for provider abstraction  
✅ **Factory pattern** for runtime provider selection  
✅ **MinIO support** for local-first development  
✅ **R2 support** for production  
✅ **Backward compatible** (old code still works)  
✅ **Type-safe** with TypeScript  
✅ **Easy to test** with interface mocking  
✅ **Extensible** for future providers  

**Result**: Clean, maintainable, and flexible storage layer! 🎉

---

**Next Steps**:
1. Test locally with MinIO
2. Verify production R2 still works
3. Add integration tests
4. Document in main README

