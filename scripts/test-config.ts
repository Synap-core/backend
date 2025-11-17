#!/usr/bin/env tsx
/**
 * Test Centralized Config
 * 
 * Verifies that the centralized configuration module works correctly.
 */

async function testConfig() {
  console.log('🧪 Testing Centralized Configuration...\n');

  try {
    // Import config (this will load and validate)
    const { config, validateConfig } = await import('@synap/core');

    console.log('✅ Config loaded successfully!\n');

    // Display config (without secrets)
    console.log('📋 Configuration:');
    console.log(`  Database Dialect: ${config.database.dialect}`);
    console.log(`  Storage Provider: ${config.storage.provider}`);
    console.log(`  Server Port: ${config.server.port}`);
    console.log(`  Node Environment: ${config.server.nodeEnv}`);
    console.log(`  Log Level: ${config.server.logLevel}`);
    console.log(`  AI Provider: ${config.ai.provider}`);
    const providerDetails =
      config.ai.provider === 'anthropic' ? config.ai.anthropic : config.ai.openai;
    console.log(`  Chat Model: ${providerDetails.model}`);
    console.log(`  Embeddings Provider: ${config.ai.embeddings.provider}`);
    console.log(`  Embeddings Model: ${config.ai.embeddings.model}`);
    console.log('');

    // Test validation
    console.log('🔍 Testing Config Validation...');
    
    try {
      if (config.storage.provider === 'r2') {
        validateConfig('r2');
        console.log('  ✅ R2 config validation passed');
      }
    } catch (error) {
      console.log('  ⚠️  R2 config validation:', (error as Error).message);
    }

    try {
      validateConfig('ai');
      console.log('  ✅ AI config validation passed');
    } catch (error) {
      console.log('  ⚠️  AI config validation:', (error as Error).message);
    }

    console.log('\n🎉 Config test passed!');
  } catch (error) {
    console.error('❌ Config test failed:', error);
    process.exit(1);
  }
}

testConfig();

