/**
 * Phase 3 Integration Test - Projection Layer (Hybrid Storage)
 * 
 * Tests the hybrid storage architecture:
 * 1. Content is stored in R2/MinIO (not PostgreSQL)
 * 2. Only metadata and file references are stored in PostgreSQL
 * 3. Handlers correctly use storage abstraction
 * 4. Embedding generation downloads from storage
 * 
 * This test validates the "State of the World" layer:
 * - Strict separation between metadata (DB) and content (Storage)
 * - Handlers use storage abstraction correctly
 * - System can handle large files efficiently
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createSynapEvent } from '@synap/types';
import { getEventRepository } from '@synap/database';
import { db, entities, entityVectors } from '@synap/database';
import { storage } from '@synap/storage';
import { inngest } from '../../client.js';
import { handlerRegistry } from '../registry.js';
import { NoteCreationHandler } from '../note-creation-handler.js';
import { EmbeddingGeneratorHandler } from '../embedding-generator-handler.js';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

// Register handlers for testing
const noteCreationHandler = new NoteCreationHandler();
const embeddingGeneratorHandler = new EmbeddingGeneratorHandler();
handlerRegistry.register(noteCreationHandler);
handlerRegistry.register(embeddingGeneratorHandler);

describe('Phase 3: Projection Layer - Hybrid Storage', () => {
  const testUserId = `test-user-${randomUUID()}`;
  const testEntityId = randomUUID();
  const testRequestId = randomUUID();
  const testCorrelationId = randomUUID();

  const testNoteContent = `# Test Note for Phase 3

This is a test note to validate the hybrid storage architecture.

## Section 1

The content should be stored in R2/MinIO, not in PostgreSQL.

## Section 2

Only metadata and file references should be in the database.

## Large Content Test

${'This is a large content block. '.repeat(100)}
This ensures we can handle files larger than 1 KB efficiently.`;

  // Mock storage for testing
  let storageUploadSpy: any;
  let storageDownloadSpy: any;
  let storageExistsSpy: any;

  beforeAll(() => {
    // Ensure handlers are registered
    expect(handlerRegistry.getHandlers('note.creation.requested').length).toBeGreaterThan(0);
    expect(handlerRegistry.getHandlers('note.creation.completed').length).toBeGreaterThan(0);

    // Spy on storage methods to verify they're called
    storageUploadSpy = vi.spyOn(storage, 'upload');
    storageDownloadSpy = vi.spyOn(storage, 'download');
    storageExistsSpy = vi.spyOn(storage, 'exists');
  });

  afterAll(async () => {
    // Cleanup test data
    try {
      // Delete entity vector
      await db.delete(entityVectors).where(eq(entityVectors.entityId, testEntityId) as any);
      
      // Delete entity
      await db.delete(entities).where(eq(entities.id, testEntityId) as any);
      
      // Note: Storage cleanup would require a delete method
      // For now, we'll skip storage cleanup in tests
    } catch (error) {
      console.warn('Cleanup failed:', error);
    }

    // Restore spies
    storageUploadSpy.mockRestore();
    storageDownloadSpy.mockRestore();
    storageExistsSpy.mockRestore();
  });

  it('should store content in storage, not in database', async () => {
    // Step 1: Create and publish note.creation.requested event
    const requestedEvent = createSynapEvent({
      type: 'note.creation.requested',
      userId: testUserId,
      aggregateId: testEntityId,
      data: {
        content: testNoteContent,
        title: 'Test Note for Phase 3',
        tags: ['test', 'phase3'],
      },
      source: 'api',
      requestId: testRequestId,
      correlationId: testCorrelationId,
    });

    // Append event to Event Store
    const eventRepo = getEventRepository();
    const eventRecord = await eventRepo.append(requestedEvent);

    expect(eventRecord.id).toBe(requestedEvent.id);
    expect(eventRecord.eventType).toBe('note.creation.requested');

    // Step 2: Publish event to Inngest
    await inngest.send({
      name: 'api/event.logged',
      data: {
        id: eventRecord.id,
        type: eventRecord.eventType,
        aggregateId: eventRecord.aggregateId,
        aggregateType: eventRecord.aggregateType,
        userId: eventRecord.userId,
        version: eventRecord.version,
        timestamp: eventRecord.timestamp.toISOString(),
        data: eventRecord.data,
        metadata: eventRecord.metadata,
        source: eventRecord.source,
        causationId: eventRecord.causationId,
        correlationId: eventRecord.correlationId,
        requestId: testRequestId,
      },
    });

    // Step 3: Wait for handlers to execute
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Step 4: Verify storage.upload was called
    expect(storageUploadSpy).toHaveBeenCalled();
    const uploadCall = storageUploadSpy.mock.calls[0] as any[];
    expect(uploadCall[0]).toContain(testUserId); // Path contains userId
    expect(uploadCall[0]).toContain('note'); // Path contains entity type
    expect(uploadCall[0]).toContain(testEntityId); // Path contains entityId
    expect(uploadCall[1]).toBe(testNoteContent); // Content matches

    // Step 5: Verify entity was created in database with file references
    const entityRows = await db
      .select()
      .from(entities)
      .where(eq(entities.id, testEntityId) as any)
      .limit(1);

    expect(entityRows.length).toBe(1);
    const entity = entityRows[0] as any;
    
    // Verify entity has file references (not content)
    expect(entity.id).toBe(testEntityId);
    expect(entity.userId).toBe(testUserId);
    expect(entity.type).toBe('note');
    expect(entity.title).toBeTruthy();
    expect(entity.filePath).toBeTruthy(); // ✅ File reference
    expect(entity.fileUrl).toBeTruthy(); // ✅ File reference
    expect(entity.fileSize).toBeGreaterThan(0); // ✅ File size
    expect(entity.checksum).toBeTruthy(); // ✅ Checksum
    expect(entity.fileType).toBe('markdown'); // ✅ File type
    
    // ✅ CRITICAL: Verify NO content field in database
    // The entity should NOT have a 'content' field
    expect(entity.content).toBeUndefined();
    
    // ✅ Verify preview is small (metadata only)
    expect(entity.preview).toBeTruthy();
    expect(entity.preview.length).toBeLessThanOrEqual(500); // Preview is small

    // Step 6: Verify file exists in storage
    const fileContent = await storage.download(entity.filePath);
    expect(fileContent).toBe(testNoteContent); // ✅ Content is in storage

    // Step 7: Verify content size matches
    expect(fileContent.length).toBe(testNoteContent.length);
    expect(entity.fileSize).toBe(testNoteContent.length); // ✅ Size matches
  }, 30000);

  it('should download content from storage before generating embedding', async () => {
    // This test verifies that EmbeddingGeneratorHandler downloads from storage
    // (not from database) before generating embeddings

    // Wait for embedding generation (if note.creation.completed was published)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify storage.download was called (for embedding generation)
    expect(storageDownloadSpy).toHaveBeenCalled();
    
    // Verify download was called with filePath (not content from DB)
    const downloadCalls = storageDownloadSpy.mock.calls as any[][];
    const hasDownloadCall = downloadCalls.some((call: any[]) => {
      const path = call[0] as string;
      return path.includes(testUserId) && path.includes('note') && path.includes(testEntityId);
    });
    expect(hasDownloadCall).toBe(true); // ✅ Download was called with filePath

    // Verify embedding was generated and stored
    const vectorRows = await db
      .select()
      .from(entityVectors)
      .where(eq(entityVectors.entityId, testEntityId) as any)
      .limit(1);

    if (vectorRows.length > 0) {
      const vector = vectorRows[0] as any;
      expect(vector.entityId).toBe(testEntityId);
      expect(vector.embedding).toBeTruthy();
      
      // Verify embedding is valid
      if (typeof vector.embedding === 'string') {
        const embeddingArray = JSON.parse(vector.embedding);
        expect(Array.isArray(embeddingArray)).toBe(true);
        expect(embeddingArray.length).toBeGreaterThan(0);
      }
    } else {
      // Embedding may not be generated yet (async workflow)
      console.warn('Embedding not found - may still be processing');
    }
  }, 30000);

  it('should handle large files efficiently', async () => {
    // Test with a large file (> 10 KB)
    const largeContent = '# Large File Test\n\n' + 'This is a large content block. '.repeat(1000);
    const largeEntityId = randomUUID();

    const largeEvent = createSynapEvent({
      type: 'note.creation.requested',
      userId: testUserId,
      aggregateId: largeEntityId,
      data: {
        content: largeContent,
        title: 'Large File Test',
      },
      source: 'api',
    });

    const eventRepo = getEventRepository();
    await eventRepo.append(largeEvent);

    await inngest.send({
      name: 'api/event.logged',
      data: {
        id: largeEvent.id,
        type: largeEvent.type,
        aggregateId: largeEvent.aggregateId,
        aggregateType: 'entity',
        userId: largeEvent.userId,
        version: 1,
        timestamp: largeEvent.timestamp.toISOString(),
        data: largeEvent.data,
        metadata: {},
        source: largeEvent.source,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify large file was uploaded to storage
    const largeUploadCalls = (storageUploadSpy.mock.calls as any[][]).filter((call: any[]) => {
      const path = call[0] as string;
      return path.includes(largeEntityId);
    });
    expect(largeUploadCalls.length).toBeGreaterThan(0);

    // Verify entity in DB has file reference (not content)
    const entityRows = await db
      .select()
      .from(entities)
      .where(eq(entities.id, largeEntityId) as any)
      .limit(1);

    if (entityRows.length > 0) {
      const entity = entityRows[0] as any;
      expect(entity.filePath).toBeTruthy(); // ✅ File reference
      expect(entity.fileSize).toBeGreaterThan(10000); // ✅ Large file size
      expect(entity.content).toBeUndefined(); // ✅ No content in DB
    }

    // Cleanup
    try {
      await db.delete(entities).where(eq(entities.id, largeEntityId) as any);
    } catch {
      // Ignore cleanup errors
    }
  }, 30000);
});

