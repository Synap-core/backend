#!/bin/sh
# Kratos entrypoint that generates kratos.yml from template with dynamic CORS origins

KRATOS_CONFIG_DIR="/etc/config/kratos"
TEMPLATE_FILE="${KRATOS_CONFIG_DIR}/kratos.yml.template"
OUTPUT_FILE="${KRATOS_CONFIG_DIR}/kratos.yml"

# Generate config if template exists and output doesn't exist or is older
if [ -f "$TEMPLATE_FILE" ] && ([ ! -f "$OUTPUT_FILE" ] || [ "$TEMPLATE_FILE" -nt "$OUTPUT_FILE" ]); then
  echo "🔧 Generating kratos.yml from template with dynamic CORS origins..."
  
  # Get allowed origins from ALLOWED_ORIGINS env var, or use defaults
  if [ -z "$ALLOWED_ORIGINS" ]; then
    # Default origins for development
    ALLOWED_ORIGINS="http://localhost:3000,http://localhost:5173,http://localhost:3001"
    echo "⚠️  ALLOWED_ORIGINS not set, using defaults: $ALLOWED_ORIGINS"
  else
    echo "✅ Using ALLOWED_ORIGINS: $ALLOWED_ORIGINS"
  fi
  
  # Also include the backend domain itself (for same-origin requests)
  if [ -n "$DOMAIN" ]; then
    BACKEND_ORIGIN="https://${DOMAIN}"
    # Add backend origin if not already in the list
    if echo "$ALLOWED_ORIGINS" | grep -qv "$BACKEND_ORIGIN"; then
      ALLOWED_ORIGINS="${ALLOWED_ORIGINS},${BACKEND_ORIGIN}"
      echo "✅ Added backend origin: $BACKEND_ORIGIN"
    fi
  fi
  
  # Convert comma-separated list to YAML array format
  YAML_ORIGINS=""
  IFS=','
  for origin in $ALLOWED_ORIGINS; do
    origin=$(echo "$origin" | xargs) # trim whitespace
    if [ -n "$origin" ]; then
      YAML_ORIGINS="${YAML_ORIGINS}        - ${origin}\n"
    fi
  done
  
  # Generate kratos.yml from template
  # Replace the placeholder with actual origins
  # Use awk for more reliable replacement
  awk -v origins="$YAML_ORIGINS" '
    /# {{ALLOWED_ORIGINS}}/ {
      gsub(/# {{ALLOWED_ORIGINS}}/, origins)
    }
    { print }
  ' "$TEMPLATE_FILE" > "$OUTPUT_FILE.tmp" && mv "$OUTPUT_FILE.tmp" "$OUTPUT_FILE"
  
  if [ $? -eq 0 ]; then
    echo "✅ Generated ${OUTPUT_FILE} with dynamic CORS origins"
  else
    echo "❌ Failed to generate config, using template as-is"
    cp "$TEMPLATE_FILE" "$OUTPUT_FILE"
  fi
else
  if [ ! -f "$OUTPUT_FILE" ]; then
    echo "⚠️  No kratos.yml found and template not available, Kratos may fail to start"
  else
    echo "ℹ️  Using existing kratos.yml (template not found or config is up to date)"
  fi
fi

# Execute the original Kratos command
exec "$@"
