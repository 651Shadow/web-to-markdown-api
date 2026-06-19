# Web to Markdown API

Convert a public web page or raw HTML document into cleaner Markdown for LLM ingestion and archival workflows.

## What it supports
- fetch mode via `url`
- direct HTML ingestion via `html` or `Content-Type: text/html`
- aggressive HTML cleanup before Markdown conversion
- relative-link resolution when `base_url` is provided
- request authentication with RapidAPI proxy secret or admin key

## Security notes
This repo is intended to stay **private until deployment credentials and rate-limiting are in place**. The handler now blocks:
- localhost and private-network targets
- redirect chains that land on private addresses
- non-HTML fetched responses in URL mode
- oversized pages and HTML payloads
- unauthenticated requests unless `ALLOW_UNAUTHENTICATED_DEV=true`
- bursty callers via a lightweight in-memory rate limiter

## API shape
### GET
```bash
curl -G 'https://your-api.vercel.app/'   --data-urlencode 'url=https://example.com/article'   -H 'x-rapidapi-proxy-secret: YOUR_SECRET'
```

### POST JSON
```bash
curl -X POST 'https://your-api.vercel.app/'   -H 'Content-Type: application/json'   -H 'x-rapidapi-proxy-secret: YOUR_SECRET'   -d '{"url":"https://example.com/article"}'
```

### POST raw HTML
```bash
curl -X POST 'https://your-api.vercel.app/'   -H 'Content-Type: text/html'   -H 'x-rapidapi-proxy-secret: YOUR_SECRET'   --data-binary @page.html
```

## Local development
```bash
npm install
npm run test
npm run typecheck
npm run build
```

## Environment variables
```env
RAPIDAPI_SECRET=replace-me
ADMIN_SECRET=replace-me
ALLOW_UNAUTHENTICATED_DEV=false
RATE_LIMIT_MAX=30
RATE_LIMIT_WINDOW_MS=60000
```

Use `.env.example` as the local starting point. In shared environments, leave `ALLOW_UNAUTHENTICATED_DEV=false`.

## Current limits
- 8 second fetch timeout
- 2MB max content size in free-tier mode
- fetch mode accepts only HTTP/HTTPS URLs that resolve to public addresses

## Next improvements
- move from in-memory throttling to deployment-backed quotas if the API is ever exposed publicly
- add integration tests around the Vercel handler
- publish usage examples only after production auth and quotas are configured
