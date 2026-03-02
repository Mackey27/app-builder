# Backend Deployment (APK Builder)

This project should be split into:

- Frontend on Vercel (static from `public/`)
- Backend (`server.js`) on a Docker-capable host with Java + Android SDK

## 1) Build and run locally (Docker)

```bash
docker build -t app-builder-backend .
docker run --rm -p 3000:3000 app-builder-backend
```

Health check:

```bash
curl http://localhost:3000/health
```

## 2) Deploy backend to your container host

Use the same Dockerfile on Railway/Render/Fly.io/VPS Docker.
Expose port `3000` (or platform `PORT` env, already supported).

## 3) Point frontend to backend

Edit `public/config.js`:

```js
window.APP_CONFIG = {
  API_BASE_URL: 'https://your-backend-domain.com'
};
```

Then redeploy frontend to Vercel:

```bash
vercel --prod --yes
```
