#!/bin/bash
set -e

echo "🔄 Running Kratos migrations..."

# Wait for Postgres to be ready (using netcat - available in Kratos image)
until nc -z postgres 5432; do
  echo "⏳ Waiting for PostgreSQL..."
  sleep 1
done

echo "✅ PostgreSQL ready"

# Run migrations
kratos migrate sql -e --yes

echo "✅ Kratos migrations complete!"

# Prepare configuration with runtime secrets
# Kratos config doesn't support env vars natively, so we substitute using sed
echo "🔧 preparing Kratos configuration..."
cp /etc/config/kratos/kratos.yml /tmp/kratos.yml
sed -i "s/\${KRATOS_WEBHOOK_SECRET}/${KRATOS_WEBHOOK_SECRET}/g" /tmp/kratos.yml

# Start Kratos server using processed config
exec kratos serve -c /tmp/kratos.yml --dev --watch-courier
