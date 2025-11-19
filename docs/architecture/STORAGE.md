# Storage System

**Système de stockage hybride pour Synap Backend**

---

## 🎯 Vue d'Ensemble

Synap utilise un **système de stockage hybride** qui sépare strictement :
- **Métadonnées** : Stockées dans PostgreSQL/SQLite (rapide, indexable)
- **Contenu** : Stocké dans R2/MinIO (économique, scalable)

Cette séparation permet :
- ✅ **Performance** : Requêtes rapides sur métadonnées
- ✅ **Coût** : Stockage de contenu 15x moins cher
- ✅ **Scalabilité** : Contenu illimité sans impact sur la DB
- ✅ **Flexibilité** : Switch entre R2 (production) et MinIO (local)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Application Layer                                       │
│  import { storage } from '@synap/storage'               │
└────────────────────┬────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────┐
│  Storage Factory                                         │
│  • Auto-détection du provider (R2/MinIO)                │
│  • Interface unifiée (IFileStorage)                     │
└────────────────────┬────────────────────────────────────┘
                     ↓
        ┌────────────┴────────────┐
        ↓                         ↓
┌───────────────┐        ┌───────────────┐
│  R2 Provider  │        │  MinIO Provider│
│  (Production) │        │  (Local Dev)   │
└───────────────┘        └───────────────┘
        ↓                         ↓
┌───────────────┐        ┌───────────────┐
│ Cloudflare R2 │        │  MinIO Server │
│  (S3-compat)  │        │  (Docker)     │
└───────────────┘        └───────────────┘
```

---

## 📦 Providers Disponibles

### 1. Cloudflare R2 (Production)

**Avantages :**
- ✅ Zero egress fees
- ✅ S3-compatible API
- ✅ 15x moins cher que PostgreSQL storage
- ✅ Scalable à l'infini

**Configuration :**
```env
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET_NAME=synap-storage
R2_PUBLIC_URL=https://pub-xxx.r2.dev
```

### 2. MinIO (Local Development)

**Avantages :**
- ✅ 100% S3-compatible
- ✅ Run en local (Docker)
- ✅ Zero cloud dependencies
- ✅ Parfait pour développement

**Configuration :**
```env
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=synap-storage
```

**Auto-détection :** Si `STORAGE_PROVIDER` n'est pas défini, le système utilise automatiquement MinIO si les credentials R2 sont absents.

---

## 🔧 Utilisation

### Interface Unifiée

```typescript
import { storage } from '@synap/storage';

// Upload
const metadata = await storage.upload(
  'user-123/note-456.md',
  '# My Note\n\nContent here',
  { contentType: 'text/markdown' }
);

// Download
const content = await storage.download('user-123/note-456.md');

// Delete
await storage.delete('user-123/note-456.md');

// Build path
const path = storage.buildPath(userId, 'note', entityId, 'md');
// Returns: "user-123/note-456.md"
```

### Structure des Chemins

Les chemins suivent le pattern :
```
{userId}/{entityType}/{entityId}.{extension}
```

**Exemples :**
- `user-123/note-abc-456.md`
- `user-123/task-xyz-789.md`
- `user-123/project-def-012.md`

---

## 🔄 Migration entre Providers

### De MinIO vers R2

1. **Configurer R2** dans `.env`
2. **Copier les fichiers** :
   ```bash
   # Utiliser aws-cli ou rclone
   aws s3 sync s3://minio-bucket s3://r2-bucket \
     --endpoint-url http://localhost:9000 \
     --source-region us-east-1
   ```
3. **Mettre à jour** `STORAGE_PROVIDER=r2`
4. **Redémarrer** le backend

### De R2 vers MinIO

1. **Configurer MinIO** dans `.env`
2. **Copier les fichiers** depuis R2
3. **Mettre à jour** `STORAGE_PROVIDER=minio`
4. **Redémarrer** le backend

---

## 📊 Séparation Métadonnées/Contenu

### Métadonnées (PostgreSQL/SQLite)

Stockées dans la table `entities` :
```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,        -- 'note', 'task', 'project'
  title TEXT,
  preview TEXT,              -- Premiers 500 caractères
  file_url TEXT,              -- URL vers le contenu
  file_path TEXT,             -- Chemin dans le storage
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

### Contenu (R2/MinIO)

Stocké comme fichiers dans le storage :
- Format : Markdown, texte, etc.
- Chemin : `{userId}/{type}/{id}.md`
- Métadonnées : Content-Type, taille, checksum

---

## 🎯 Best Practices

1. **Toujours utiliser l'interface unifiée** : `import { storage } from '@synap/storage'`
2. **Ne jamais accéder directement** aux providers (R2/MinIO)
3. **Utiliser `buildPath()`** pour générer les chemins
4. **Gérer les erreurs** : Les providers peuvent échouer
5. **Tester avec MinIO** en local, R2 en production

---

## 🔗 Liens Utils

- **[Getting Started](../getting-started/README.md)** - Installation
- **[Architecture Overview](./README.md)** - Vue d'ensemble
- **[Deployment](../deployment/README.md)** - Déploiement

