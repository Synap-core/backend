#!/bin/bash
#
# Audit Report Generator for Hub Protocol
#
# Creates a comprehensive audit report of the current state of the system
#

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

REPORT_DIR="docs/architecture/audit-reports"
REPORT_FILE="${REPORT_DIR}/audit-$(date +%Y%m%d-%H%M%S).md"

mkdir -p "$REPORT_DIR"

echo "🔍 Génération du Rapport d'Audit..."
echo ""

# Start report
cat > "$REPORT_FILE" << EOF
# Audit Report - Hub Protocol & Intelligence Hub

**Date :** $(date +"%Y-%m-%d %H:%M:%S")  
**Version :** 1.0.0

---

## 📊 Résumé Exécutif

Ce rapport documente l'état actuel du système Hub Protocol et Intelligence Hub.

---

## 1. Tests Existants

EOF

# Count test files
TEST_FILES=$(find packages -name "*.test.ts" 2>/dev/null | wc -l | tr -d ' ')
TEST_DIRS=$(find packages -name "__tests__" -type d 2>/dev/null | wc -l | tr -d ' ')

echo "### Statistiques" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "- **Fichiers de test :** $TEST_FILES" >> "$REPORT_FILE"
echo "- **Dossiers de test :** $TEST_DIRS" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# List test files
echo "### Fichiers de Test" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
find packages -name "*.test.ts" 2>/dev/null | while read -r file; do
  echo "- \`$file\`" >> "$REPORT_FILE"
done
echo "" >> "$REPORT_FILE"

# Test execution
echo "### Résultats d'Exécution" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "\`\`\`" >> "$REPORT_FILE"
pnpm test 2>&1 | tee -a "$REPORT_FILE" || echo "⚠️  Tests non exécutés" >> "$REPORT_FILE"
echo "\`\`\`" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# Build status
cat >> "$REPORT_FILE" << EOF

## 2. Build Status

EOF

echo "\`\`\`" >> "$REPORT_FILE"
pnpm build 2>&1 | tee -a "$REPORT_FILE" || echo "⚠️  Build échoué" >> "$REPORT_FILE"
echo "\`\`\`" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# Docker services
cat >> "$REPORT_FILE" << EOF

## 3. Services Docker

EOF

echo "\`\`\`" >> "$REPORT_FILE"
docker compose ps 2>&1 | tee -a "$REPORT_FILE" || echo "⚠️  Docker non disponible" >> "$REPORT_FILE"
echo "\`\`\`" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# Environment variables
cat >> "$REPORT_FILE" << EOF

## 4. Variables d'Environnement

EOF

if [ -f .env ]; then
  echo "### Variables Requises" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  
  required_vars=(
    "ANTHROPIC_API_KEY"
    "HYDRA_PUBLIC_URL"
    "HYDRA_ADMIN_URL"
    "KRATOS_PUBLIC_URL"
    "KRATOS_ADMIN_URL"
    "DATABASE_URL"
    "MEM0_API_URL"
    "MEM0_API_KEY"
    "HUB_CLIENT_ID"
    "HUB_CLIENT_SECRET"
  )
  
  for var in "${required_vars[@]}"; do
    if [ -n "${!var}" ]; then
      echo "- ✅ \`$var\` : Configuré" >> "$REPORT_FILE"
    else
      echo "- ❌ \`$var\` : **MANQUANT**" >> "$REPORT_FILE"
    fi
  done
else
  echo "⚠️  Fichier .env non trouvé" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# Code quality
cat >> "$REPORT_FILE" << EOF

## 5. Qualité du Code

EOF

echo "### Erreurs TypeScript" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "\`\`\`" >> "$REPORT_FILE"
pnpm build 2>&1 | grep -E "error TS" | head -20 | tee -a "$REPORT_FILE" || echo "✅ Aucune erreur TypeScript" >> "$REPORT_FILE"
echo "\`\`\`" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# Package status
cat >> "$REPORT_FILE" << EOF

## 6. Statut des Packages

EOF

packages=(
  "@synap/hub-protocol"
  "@synap/intelligence-hub"
  "@synap/api"
  "@synap/auth"
  "@synap/database"
  "@synap/core"
)

for pkg in "${packages[@]}"; do
  echo "### $pkg" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  
  # Check if package has build script
  if pnpm --filter "$pkg" build > /dev/null 2>&1; then
    echo "- ✅ Build : Succès" >> "$REPORT_FILE"
  else
    echo "- ❌ Build : Échec" >> "$REPORT_FILE"
  fi
  
  # Check if package has tests
  if pnpm --filter "$pkg" test > /dev/null 2>&1; then
    echo "- ✅ Tests : Disponibles" >> "$REPORT_FILE"
  else
    echo "- ⚠️  Tests : Non disponibles" >> "$REPORT_FILE"
  fi
  
  echo "" >> "$REPORT_FILE"
done

# Recommendations
cat >> "$REPORT_FILE" << EOF

## 7. Recommandations

### Tests Manquants

- [ ] Tests pour \`packages/api/src/routers/hub.ts\`
- [ ] Tests pour \`packages/intelligence-hub/src/services/hub-orchestrator.ts\`
- [ ] Tests d'intégration Data Pod ↔ Hub
- [ ] Tests E2E complets
- [ ] Tests de sécurité
- [ ] Tests de performance

### Actions Immédiates

1. Créer les tests manquants critiques
2. Exécuter tous les tests existants
3. Corriger les erreurs de build
4. Vérifier la configuration OAuth2
5. Valider les services Docker

---

**Rapport généré le :** $(date +"%Y-%m-%d %H:%M:%S")  
**Fichier :** \`$REPORT_FILE\`

EOF

echo -e "${GREEN}✅ Rapport d'audit créé : $REPORT_FILE${NC}"
echo ""
echo "📊 Résumé :"
echo "  - Fichiers de test : $TEST_FILES"
echo "  - Dossiers de test : $TEST_DIRS"
echo ""
echo "📝 Voir le rapport complet :"
echo "  cat $REPORT_FILE"

