#!/bin/bash
# Quick verification script for Kratos configuration
# Run from deploy/ directory: ./verify-kratos.sh

set -e

echo "🔍 Kratos Configuration Verification"
echo "===================================="
echo ""

# Check if we're in the right directory
if [ ! -f "docker-compose.yml" ]; then
    echo "❌ Error: Must run from deploy/ directory"
    exit 1
fi

# 1. Check if kratos.yml exists
echo "1️⃣  Checking kratos.yml file..."
if [ -f "../kratos/kratos.yml" ]; then
    echo "   ✅ kratos.yml exists"
    
    # Check if it has placeholder webhook secret
    if grep -q "CHANGE_ME" ../kratos/kratos.yml; then
        echo "   ⚠️  WARNING: kratos.yml contains 'CHANGE_ME' placeholder!"
        echo "   ⚠️  Webhook secret not properly configured"
    elif grep -q "\${KRATOS_WEBHOOK_SECRET}" ../kratos/kratos.yml; then
        echo "   ⚠️  WARNING: kratos.yml contains '\${KRATOS_WEBHOOK_SECRET}' placeholder!"
        echo "   ⚠️  Environment variable substitution not working"
    else
        echo "   ✅ Webhook secret appears to be set (no placeholders found)"
    fi
    
    # Extract webhook secret from kratos.yml
    WEBHOOK_IN_CONFIG=$(grep "X-Webhook-Secret:" ../kratos/kratos.yml | sed 's/.*X-Webhook-Secret: //' | tr -d ' ' || echo "")
    if [ -n "$WEBHOOK_IN_CONFIG" ]; then
        echo "   📝 Webhook secret in config: ${WEBHOOK_IN_CONFIG:0:10}... (first 10 chars)"
    fi
else
    echo "   ❌ kratos.yml NOT FOUND!"
    echo "   💡 Run: ./synap install --domain <your-domain> to generate it"
fi

echo ""

# 2. Check .env file for webhook secret
echo "2️⃣  Checking .env file..."
if [ -f ".env" ]; then
    echo "   ✅ .env file exists"
    
    # Check if readable
    if [ ! -r ".env" ]; then
        echo "   ⚠️  .env file exists but is not readable (permission denied)"
        echo "   💡 Fix permissions: chmod 644 .env"
        echo "   💡 Or run as correct user: sudo chown \$USER:\$USER .env"
    else
        # Use cat to avoid permission issues with grep
        if cat .env 2>/dev/null | grep -q "^KRATOS_WEBHOOK_SECRET="; then
            WEBHOOK_IN_ENV=$(cat .env 2>/dev/null | grep "^KRATOS_WEBHOOK_SECRET=" | cut -d'=' -f2- | tr -d ' ' | tr -d '"' || echo "")
            if [ -n "$WEBHOOK_IN_ENV" ]; then
                echo "   ✅ KRATOS_WEBHOOK_SECRET found in .env"
                echo "   📝 Webhook secret in .env: ${WEBHOOK_IN_ENV:0:10}... (first 10 chars)"
                
                # Compare with config
                if [ -f "../kratos/kratos.yml" ] && [ -n "$WEBHOOK_IN_CONFIG" ]; then
                    if [ "$WEBHOOK_IN_CONFIG" = "$WEBHOOK_IN_ENV" ]; then
                        echo "   ✅ Webhook secrets MATCH between .env and kratos.yml"
                    else
                        echo "   ❌ Webhook secrets DO NOT MATCH!"
                        echo "   💡 Regenerate kratos.yml: ../synap install --domain <your-domain> --non-interactive"
                    fi
                fi
            else
                echo "   ⚠️  KRATOS_WEBHOOK_SECRET is empty in .env"
            fi
        else
            echo "   ❌ KRATOS_WEBHOOK_SECRET not found in .env"
        fi
    fi
else
    echo "   ❌ .env file NOT FOUND!"
fi

echo ""

# 3. Check CORS configuration in kratos.yml
echo "3️⃣  Checking CORS configuration..."
if [ -f "../kratos/kratos.yml" ]; then
    # Check if localhost:3000 is in allowed origins
    if grep -A 10 "allowed_origins:" ../kratos/kratos.yml | grep -q "localhost:3000"; then
        echo "   ✅ localhost:3000 is in allowed CORS origins"
    else
        echo "   ⚠️  localhost:3000 NOT found in allowed CORS origins"
    fi
    
    # Check if production domain is in allowed origins
    DOMAIN=$(grep "^DOMAIN=" .env 2>/dev/null | cut -d'=' -f2- || echo "")
    if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "localhost" ]; then
        if grep -A 10 "allowed_origins:" ../kratos/kratos.yml | grep -q "$DOMAIN"; then
            echo "   ✅ $DOMAIN is in allowed CORS origins"
        else
            echo "   ⚠️  $DOMAIN NOT found in allowed CORS origins"
        fi
    fi
    
    # Check if allow_credentials is true
    if grep -q "allow_credentials: true" ../kratos/kratos.yml; then
        echo "   ✅ allow_credentials is enabled"
    else
        echo "   ⚠️  allow_credentials is NOT enabled"
    fi
fi

echo ""

# 4. Check Kratos service environment variables
echo "4️⃣  Checking Kratos Docker service..."
if docker compose ps kratos 2>/dev/null | grep -q "Up"; then
    echo "   ✅ Kratos service is running"
    
    # Check if KRATOS_WEBHOOK_SECRET is set in container
    if docker compose exec -T kratos env 2>/dev/null | grep -q "KRATOS_WEBHOOK_SECRET"; then
        echo "   ✅ KRATOS_WEBHOOK_SECRET is set in Kratos container"
    else
        echo "   ⚠️  KRATOS_WEBHOOK_SECRET NOT set in Kratos container"
        echo "   💡 Check docker-compose.yml - Kratos service needs this env var"
    fi
else
    echo "   ⚠️  Kratos service is NOT running"
    echo "   💡 Start it: docker compose up -d kratos"
fi

echo ""

# 5. Check actual webhook secret in running Kratos config
echo "5️⃣  Checking actual webhook secret in Kratos config..."
if docker compose ps kratos 2>/dev/null | grep -q "Up"; then
    # Try to read the config from the container
    if docker compose exec -T kratos cat /etc/config/kratos/kratos.yml 2>/dev/null | grep -q "X-Webhook-Secret:"; then
        CONTAINER_SECRET=$(docker compose exec -T kratos cat /etc/config/kratos/kratos.yml 2>/dev/null | grep "X-Webhook-Secret:" | sed 's/.*X-Webhook-Secret: //' | tr -d ' ' || echo "")
        if [ -n "$CONTAINER_SECRET" ]; then
            echo "   📝 Webhook secret in container: ${CONTAINER_SECRET:0:10}... (first 10 chars)"
            
            # Compare with .env
            if [ -n "$WEBHOOK_IN_ENV" ] && [ "$CONTAINER_SECRET" = "$WEBHOOK_IN_ENV" ]; then
                echo "   ✅ Container secret matches .env"
            elif [ -n "$WEBHOOK_IN_ENV" ]; then
                echo "   ❌ Container secret DOES NOT match .env!"
                echo "   💡 Restart Kratos: docker compose restart kratos"
            fi
        fi
    else
        echo "   ⚠️  Could not read kratos.yml from container"
    fi
fi

echo ""

# 6. Check CORS configuration in detail
echo "6️⃣  Detailed CORS check..."
if [ -f "../kratos/kratos.yml" ]; then
    echo "   📋 Allowed CORS origins in kratos.yml:"
    grep -A 5 "allowed_origins:" ../kratos/kratos.yml | grep "    -" | sed 's/^/      /'
    
    # Check if localhost:3000 is explicitly listed
    if grep -A 5 "allowed_origins:" ../kratos/kratos.yml | grep -q "localhost:3000"; then
        echo "   ✅ localhost:3000 is explicitly allowed"
    else
        echo "   ❌ localhost:3000 NOT found in allowed origins!"
    fi
fi

echo ""

# 7. Check Kratos logs for CORS/CSRF errors
echo "7️⃣  Recent Kratos errors (last 20 lines)..."
if docker compose ps kratos 2>/dev/null | grep -q "Up"; then
    docker compose logs kratos --tail 20 2>/dev/null | grep -i "403\|cors\|csrf\|forbidden" || echo "   ℹ️  No recent CORS/CSRF errors in logs"
else
    echo "   ⚠️  Kratos not running"
fi

echo ""
echo "===================================="
echo "✅ Verification complete!"
echo ""
echo "💡 If issues found:"
echo ""
echo "   1. Regenerate kratos.yml:"
echo "      cd /opt/synap-backend/deploy"
echo "      ../synap install --domain api.thearchitech.xyz"
echo ""
echo "   2. Or manually regenerate (if already installed):"
echo "      cd /opt/synap-backend/deploy"
echo "      ../synap install --domain api.thearchitech.xyz --non-interactive"
echo ""
echo "   3. Restart Kratos to load new config:"
echo "      docker compose restart kratos"
echo ""
echo "   4. Check Kratos logs:"
echo "      docker compose logs kratos --tail 50 -f"
