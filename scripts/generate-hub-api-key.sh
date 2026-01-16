#!/bin/bash

# Generate Hub Protocol API Key
# This script creates a secure API key for Intelligence Hub authentication

# Generate random API key
API_KEY="synap_hub_live_$(openssl rand -hex 32)"

echo "🔑 Generated Hub Protocol API Key"
echo ""
echo "Add this to your Intelligence Service .env file:"
echo ""
echo "HUB_PROTOCOL_API_KEY=$API_KEY"
echo ""
echo "⚠️  IMPORTANT: Save this key securely!"
echo "   This key will be used by Intelligence Service to authenticate with the Backend."
echo ""
echo "Next steps:"
echo "1. Copy the key above"
echo "2. Add it to synap-intelligence-service/.env"
echo "3. Also add INTELLIGENCE_HUB_API_KEY=$API_KEY to synap-backend/.env"
echo "4. Run the seed script to store the hashed key in database"
echo ""
