# Documentation Consolidation Plan

## Current State Analysis

### Essential Docs (Keep & Update)
1. **README.md** - Main entry point (needs update)
2. **ARCHITECTURE.md** - Technical deep dive (needs update to reflect current code)
3. **SETUP.md** - Combined setup guide (create from QUICK-START + LOCAL-SETUP)
4. **CHANGELOG.md** - Version history (keep)

### Historical Docs (Archive/Remove)
- All V0.2, V0.3, V0.4 completion docs → Archive or remove
- Consolidation phase docs → Consolidate into one
- Technical assessment → Archive

### Consolidation Strategy

1. **Create `/docs` folder** for archived historical docs
2. **Update README.md** to reflect current state (V0.4+ with consolidation)
3. **Update ARCHITECTURE.md** to reflect actual codebase structure
4. **Create SETUP.md** combining QUICK-START + LOCAL-SETUP
5. **Create DEVELOPMENT.md** for dev-specific info
6. **Archive old docs** to `/docs/archive/`

## Files to Keep (Root)
- README.md (updated)
- ARCHITECTURE.md (updated)
- SETUP.md (new, consolidated)
- DEVELOPMENT.md (new)
- CHANGELOG.md (keep)
- STORAGE-ABSTRACTION.md (keep, technical reference)
- docker-compose.yml (keep)
- env.example files (keep)

## Files to Archive
- All V0.2-*.md → /docs/archive/
- All V0.3-*.md → /docs/archive/
- All V0.4-*.md → /docs/archive/
- CONSOLIDATION-*.md → /docs/archive/consolidation/
- CODE-CONSOLIDATION-REPORT.md → /docs/archive/
- DEAD-CODE-ANALYSIS.md → /docs/archive/
- TECHNICAL-ASSESSMENT.md → /docs/archive/
- BACKEND-STATE-REPORT.md → /docs/archive/
- SYNAP-V0.5-*.md → /docs/archive/ (if outdated)

## Files to Remove
- Duplicate setup guides (after consolidation)
- Outdated roadmap docs (if superseded)

