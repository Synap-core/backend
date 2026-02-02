# Connecting Frontend to Local Backend

**Quick guide to connect the frontend app to your local backend**

---

## 🎯 Quick Answer

**Yes!** Just set the backend URL to `http://localhost:4000` and you're good to go.

---

## 🚀 Method 1: Browser Console (Fastest)

**After starting the frontend**, open browser DevTools Console (F12) and run:

```javascript
// Set backend URL to localhost
localStorage.setItem("synap_backend_url", "http://localhost:4000");

// Verify it's set
console.log("Backend URL:", localStorage.getItem("synap_backend_url"));

// Reload page
window.location.reload();
```

**That's it!** The frontend will now connect to your local backend.

---

## 🚀 Method 2: Setup Page (User-Friendly)

1. **Start the frontend**:

   ```bash
   cd synap-app
   pnpm dev
   ```

2. **Navigate to**: `http://localhost:3000/setup`

3. **Enter backend URL**: `http://localhost:4000`

4. **Click "Connect Server"**

The frontend will save this and redirect you to login.

---

## 🚀 Method 3: Environment Variable (Persistent)

**Create/update** `.env.local` in `synap-app/apps/web/`:

```bash
cd synap-app/apps/web
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > .env.local
```

**Restart the frontend dev server** for changes to take effect.

---

## ✅ Complete Setup Checklist

### Backend (Already Done ✅)

- [x] Local services running (`./scripts/dev-local.sh`)
- [x] Migrations completed
- [x] API running on `http://localhost:4000`

### Frontend (Do This Now)

- [ ] Start frontend: `cd synap-app && pnpm dev`
- [ ] Set backend URL (use Method 1, 2, or 3 above)
- [ ] Verify connection works

---

## 🧪 Verify Connection

**After setting the backend URL**, check:

1. **Browser Console** - Should see successful tRPC requests
2. **Network Tab** - Requests should go to `http://localhost:4000/trpc/...`
3. **Health Check** - Can manually test:
   ```bash
   curl http://localhost:4000/health
   ```

---

## 🔍 Debug Connection Issues

### Check Backend is Running

```bash
# Check if API is running
curl http://localhost:4000/health

# Check Docker services
cd synap-backend
docker compose -f docker-compose.local.yml ps
```

### Check Frontend Configuration

**In browser console**:

```javascript
// Check what's configured
console.log("Backend URL:", localStorage.getItem("synap_backend_url"));
console.log("Env var:", process.env.NEXT_PUBLIC_API_URL);

// Check cookies
console.log("Cookies:", document.cookie);
```

### Check Network Requests

1. Open DevTools → Network tab
2. Look for requests to `/trpc/...`
3. Check if they're going to `http://localhost:4000`
4. Verify status is `200 OK` (not `404` or `CORS error`)

---

## 📝 How It Works

The frontend uses this priority order:

1. **localStorage** (`synap_backend_url`) - User configured
2. **Environment Variable** (`NEXT_PUBLIC_API_URL`) - Build-time default
3. **Default fallback** - Usually `localhost:4000`

**For local development**, setting localStorage is the easiest and most flexible.

---

## 🎯 Next Steps After Connection

Once connected:

1. **Test Registration**: Go to `/auth` and create an account
2. **Test Login**: Log in with your account
3. **Test Workspace**: Should redirect to workspace after login
4. **Test Features**: Try creating entities, views, etc.

---

## 🐛 Common Issues

### "Cannot connect to backend"

**Check**:

- Is backend running? `curl http://localhost:4000/health`
- Is URL correct? Check localStorage/env var
- Are ports correct? Backend: 4000, Frontend: 3000

### "CORS errors"

**Shouldn't happen** - The frontend uses Next.js middleware rewrites for same-origin requests. If you see CORS errors, check:

- Backend CORS config allows `http://localhost:3000`
- Middleware is working correctly

### "404 on /trpc/..."

**Check**:

- Backend URL is correct (`http://localhost:4000`)
- Backend is actually running
- tRPC router is configured correctly

---

**Last Updated**: 2026-02-02
