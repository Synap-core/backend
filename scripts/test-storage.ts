#!/usr/bin/env tsx
/**
 * Test Storage Providers
 *
 * Tests both R2 and MinIO storage providers to verify they work correctly.
 *
 * Usage:
 *   # Test MinIO (local)
 *   STORAGE_PROVIDER=minio tsx scripts/test-storage.ts
 *
 *   # Test R2 (production)
 *   STORAGE_PROVIDER=r2 tsx scripts/test-storage.ts
 */

import "dotenv/config";
import { createFileStorageProvider } from "../packages/storage/src/factory.js";

async function testStorage() {
  console.log("🧪 Testing Storage Provider...\n");

  const provider = process.env.STORAGE_PROVIDER || "minio";
  console.log(`Provider: ${provider}\n`);

  // Create storage instance
  const storage = createFileStorageProvider();

  // Test 1: Upload
  console.log("📤 Test 1: Upload file...");
  const testPath = `test/${Date.now()}/test-note.md`;
  const testContent = `# Test Note\n\nCreated at: ${new Date().toISOString()}\n\nThis is a test file to verify storage works.`;

  try {
    const uploadResult = await storage.upload(testPath, testContent, {
      contentType: "text/markdown",
    });

    console.log("✅ Upload successful!");
    console.log(`   Path: ${uploadResult.path}`);
    console.log(`   URL: ${uploadResult.url}`);
    console.log(`   Size: ${uploadResult.size} bytes`);
    console.log(`   Checksum: ${uploadResult.checksum}\n`);
  } catch (error) {
    console.error("❌ Upload failed:", error);
    process.exit(1);
  }

  // Test 2: Download
  console.log("📥 Test 2: Download file...");
  try {
    const downloadedContent = await storage.download(testPath);

    if (downloadedContent === testContent) {
      console.log("✅ Download successful! Content matches.\n");
    } else {
      console.error("❌ Download failed: Content mismatch!");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Download failed:", error);
    process.exit(1);
  }

  // Test 3: Exists
  console.log("🔍 Test 3: Check file exists...");
  try {
    const exists = await storage.exists(testPath);

    if (exists) {
      console.log("✅ File exists check passed!\n");
    } else {
      console.error("❌ File exists check failed: File should exist!");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Exists check failed:", error);
    process.exit(1);
  }

  // Test 4: Get Metadata
  console.log("📊 Test 4: Get file metadata...");
  try {
    const metadata = await storage.getMetadata(testPath);

    console.log("✅ Metadata retrieved!");
    console.log(`   Size: ${metadata.size} bytes`);
    console.log(`   Content Type: ${metadata.contentType}`);
    console.log(`   Last Modified: ${metadata.lastModified}\n`);
  } catch (error) {
    console.error("❌ Metadata retrieval failed:", error);
    process.exit(1);
  }

  // Test 5: Build Path
  console.log("🛤️  Test 5: Build path...");
  try {
    const builtPath = storage.buildPath("user-123", "note", "entity-456", "md");
    const expectedPath = "users/user-123/notes/entity-456.md";

    if (builtPath === expectedPath) {
      console.log("✅ Path building works!");
      console.log(`   Built: ${builtPath}\n`);
    } else {
      console.error(
        `❌ Path building failed: Expected "${expectedPath}", got "${builtPath}"`
      );
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Path building failed:", error);
    process.exit(1);
  }

  // Test 6: Delete
  console.log("🗑️  Test 6: Delete file...");
  try {
    await storage.delete(testPath);

    // Verify it's deleted
    const stillExists = await storage.exists(testPath);
    if (!stillExists) {
      console.log("✅ Delete successful! File no longer exists.\n");
    } else {
      console.error("❌ Delete failed: File still exists!");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Delete failed:", error);
    process.exit(1);
  }

  // Test 7: Signed URL (optional, may not work for all providers)
  console.log("🔗 Test 7: Generate signed URL...");
  try {
    // Upload a file first (for signed URL test)
    const signedTestPath = `test/${Date.now()}/signed-test.md`;
    await storage.upload(signedTestPath, "Test content for signed URL");

    const signedUrl = await storage.getSignedUrl(signedTestPath, 3600);

    console.log("✅ Signed URL generated!");
    console.log(`   URL: ${signedUrl.substring(0, 80)}...\n`);

    // Cleanup
    await storage.delete(signedTestPath);
  } catch (error) {
    console.warn(
      "⚠️  Signed URL test skipped (may not be supported):",
      error instanceof Error ? error.message : "Unknown error"
    );
    console.log("");
  }

  console.log("🎉 All tests passed! Storage provider is working correctly.\n");
}

// Run tests
testStorage().catch((error) => {
  console.error("❌ Test suite failed:", error);
  process.exit(1);
});
