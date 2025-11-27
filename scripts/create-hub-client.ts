/**
 * Script to create OAuth2 client for Intelligence Hub
 * 
 * Creates a client_credentials client in Hydra for the Intelligence Hub
 * to authenticate with the Data Pod.
 */

import { AdminApi, Configuration } from '@ory/hydra-client';
import crypto from 'crypto';

const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';

// Generate a secure random client secret
function generateClientSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

async function createHubClient() {
  const hydraAdmin = new OAuth2Api(
    new Configuration({
      basePath: hydraAdminUrl,
    })
  );

  const clientId = 'synap-hub';
  const clientSecret = generateClientSecret();

  console.log('🔐 Creating OAuth2 client for Intelligence Hub...');
  console.log(`   Client ID: ${clientId}`);
  console.log(`   Admin URL: ${hydraAdminUrl}`);

  try {
    // Check if client already exists
    try {
      const existing = await hydraAdmin.getOAuth2Client({ id: clientId });
      console.log('⚠️  Client already exists. Updating...');
      
      // Update existing client
      const { data: updated } = await hydraAdmin.setOAuth2Client({
        id: clientId,
        oAuth2Client: {
          client_id: clientId,
          client_secret: clientSecret,
          client_name: 'Intelligence Hub',
          grant_types: ['client_credentials'],
          response_types: ['token'],
          scope: 'hub:read hub:write',
          token_endpoint_auth_method: 'client_secret_post',
          // Additional settings
          access_token_strategy: 'opaque',
          // No redirect URIs needed for client_credentials
          redirect_uris: [],
        },
      });

      console.log('✅ Client updated successfully!');
      console.log('\n📋 Client Configuration:');
      console.log(`   Client ID: ${updated.client_id}`);
      console.log(`   Client Secret: ${clientSecret}`);
      console.log(`   Grant Types: ${updated.grant_types?.join(', ')}`);
      console.log(`   Scopes: ${updated.scope}`);
      console.log(`   Auth Method: ${updated.token_endpoint_auth_method}`);
      
      console.log('\n📝 Add these to your .env file:');
      console.log(`   HUB_CLIENT_ID=${clientId}`);
      console.log(`   HUB_CLIENT_SECRET=${clientSecret}`);
      
      return { clientId, clientSecret };
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
      // Client doesn't exist, create it
    }

    // Create new client
    const { data: client } = await hydraAdmin.createOAuth2Client({
      oAuth2Client: {
        client_id: clientId,
        client_secret: clientSecret,
        client_name: 'Intelligence Hub',
        grant_types: ['client_credentials'],
        response_types: ['token'],
        scope: 'hub:read hub:write',
        token_endpoint_auth_method: 'client_secret_post',
        // Additional settings
        access_token_strategy: 'opaque',
        // No redirect URIs needed for client_credentials
        redirect_uris: [],
      },
    });

    console.log('✅ Client created successfully!');
    console.log('\n📋 Client Configuration:');
    console.log(`   Client ID: ${client.client_id}`);
    console.log(`   Client Secret: ${clientSecret}`);
    console.log(`   Grant Types: ${client.grant_types?.join(', ')}`);
    console.log(`   Scopes: ${client.scope}`);
    console.log(`   Auth Method: ${client.token_endpoint_auth_method}`);
    
    console.log('\n📝 Add these to your .env file:');
    console.log(`   HUB_CLIENT_ID=${clientId}`);
    console.log(`   HUB_CLIENT_SECRET=${clientSecret}`);
    
    return { clientId, clientSecret };
  } catch (error: any) {
    console.error('❌ Error creating client:', error.message);
    if (error.response) {
      console.error('   Response:', error.response.data);
    }
    process.exit(1);
  }
}

// Run script
createHubClient()
  .then(() => {
    console.log('\n✨ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });

