# Web to Markdown API

Convert a public web page or raw HTML document into cleaner Markdown for LLM ingestion, RAG pipelines, and archival workflows.

This repo is a **TypeScript/Vercel serverless reference implementation** that focuses on the part most people skip: input validation and safer fetch behavior.

## Why this is useful
- turn noisy public pages into denser Markdown for prompts and context windows
- accept either a `url` or raw HTML input
- reject obviously unsafe fetch targets instead of blindly proxying anything
- provide a small codebase that is easy to inspect, test, and extend

## Current capabilities
- fetch mode via `url`
- direct HTML ingestion via `html` or `Content-Type: text/html`
- aggressive HTML cleanup before Markdown conversion
- relative-link resolution when `base_url` is provided
- request authentication with RapidAPI proxy secret or admin key
- lightweight in-memory rate limiting

## Security posture
The handler currently blocks:
- localhost and private-network targets
- redirect chains that land on private addresses
- non-HTML fetched responses in URL mode
- oversized pages and HTML payloads
- unauthenticated requests unless `ALLOW_UNAUTHENTICATED_DEV=true`
- bursty callers via a lightweight in-memory rate limiter

This makes the repo reasonable to publish as code, but **shared/public deployments should still set real secrets and deployment-backed quotas**.

## API shape
### GET
```bash
curl -G 'https://your-api.vercel.app/' \
  --data-urlencode 'url=https://example.com/article' \
  -H 'x-rapidapi-proxy-secret: YOUR_SECRET'
```

### POST JSON
```bash
curl -X POST 'https://your-api.vercel.app/' \
  -H 'Content-Type: application/json' \
  -H 'x-rapidapi-proxy-secret: YOUR_SECRET' \
  -d '{"url":"https://example.com/article"}'
```

### POST raw HTML
```bash
curl -X POST 'https://your-api.vercel.app/' \
  -H 'Content-Type: text/html' \
  -H 'x-rapidapi-proxy-secret: YOUR_SECRET' \
  --data-binary @page.html
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

## Verification
This repo has been verified with:
- `npm test`
- `npm run typecheck`
- `npm run build`

## Current limits
- 8 second fetch timeout
- 2MB max content size in free-tier mode
- in-memory throttling only
- fetch mode accepts only HTTP/HTTPS URLs that resolve to public addresses

## Good next improvements
- move from in-memory throttling to deployment-backed quotas if traffic becomes public
- add integration tests around the Vercel handler
- add a small hosted demo only after production auth and quotas are configured

## License
MIT
