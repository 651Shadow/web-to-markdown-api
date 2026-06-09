# LLM-Ready Web Reader

> Stop wasting money on OpenAI tokens processing HTML tags. This API converts any URL **or raw HTML document** into clean, dense Markdown specifically optimized for RAG and AI Context Windows. Saves up to 60% on token costs.

## Why This Exists

When feeding web content to LLMs, you're paying for every token—including useless HTML tags, navigation menus, ads, cookie banners, and tracking scripts. This API strips all that away, delivering only the content that matters.

**Before:** 50,000 tokens of bloated HTML
**After:** 20,000 tokens of clean Markdown

## Features

- **Two Input Modes** - Fetch any URL, or send raw HTML (files, scraped pages, email bodies) directly
- **Aggressive HTML Cleaning** - Removes ads, navigation, footers, modals, cookie banners, and 50+ categories of junk
- **Token-Optimized Output** - Clean Markdown that maximizes information density
- **Absolute Links** - Relative links are resolved against the source URL (or `base_url`) so output is self-contained
- **Fast & Reliable** - 8-second timeout with graceful error handling
- **Secure** - Gatekeeper authentication pattern prevents unauthorized access
- **Size Protection** - 2MB limit prevents memory exhaustion

## Pricing

| Plan | Price | Requests/Month | Features |
|------|-------|----------------|----------|
| **Free** | $0 | 50 | Basic access, 2MB page limit |
| **Pro** | $9.99/mo | 10,000 | Priority support, larger limits |
| **Business** | $29.99/mo | 100,000 | Dedicated support, custom limits, SLA |

## Quick Start

### Via RapidAPI (Recommended)

```bash
curl -X GET "https://your-api.vercel.app/?url=https://example.com" \
  -H "x-rapidapi-proxy-secret: YOUR_RAPIDAPI_SECRET"
```

### Via POST Request

```bash
curl -X POST "https://your-api.vercel.app/" \
  -H "Content-Type: application/json" \
  -H "x-rapidapi-proxy-secret: YOUR_RAPIDAPI_SECRET" \
  -d '{"url": "https://example.com"}'
```

### Convert an HTML File Directly

Send raw HTML — no fetching involved:

```bash
# POST an HTML file as the request body
curl -X POST "https://your-api.vercel.app/" \
  -H "Content-Type: text/html" \
  -H "x-rapidapi-proxy-secret: YOUR_RAPIDAPI_SECRET" \
  --data-binary @page.html
```

Or embed HTML in a JSON body, with an optional `base_url` to resolve relative links:

```bash
curl -X POST "https://your-api.vercel.app/" \
  -H "Content-Type: application/json" \
  -H "x-rapidapi-proxy-secret: YOUR_RAPIDAPI_SECRET" \
  -d '{"html": "<html><body><h1>Hello</h1><a href=\"/docs\">Docs</a></body></html>", "base_url": "https://example.com"}'
```

### Response

```json
{
  "url": "https://example.com",
  "source": "url",
  "markdown": "# Example Domain\n\nThis domain is for use in illustrative examples...",
  "meta": {
    "title": "Example Domain",
    "original_length": 1256,
    "clean_length": 298,
    "token_savings_percentage": 76
  }
}
```

## API Reference

### Endpoint

```
GET/POST /?url={target_url}
```

### Authentication

One of the following headers is **required**:

| Header | Description |
|--------|-------------|
| `x-rapidapi-proxy-secret` | RapidAPI proxy secret (for subscribers) |
| `x-admin-key` | Admin key (for personal use/testing) |

### Parameters

Provide **either** `url` (fetch mode) **or** `html` (direct ingestion mode):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | One of `url`/`html` | The URL to fetch and convert to Markdown (GET query or POST JSON body) |
| `html` | string | One of `url`/`html` | Raw HTML to convert (POST JSON body), or POST the document directly with `Content-Type: text/html` |
| `base_url` | string | No | Base URL used to resolve relative links when sending raw HTML |

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `url` | string \| null | The source URL (or `base_url` for raw HTML; `null` if neither) |
| `source` | string | `"url"` (fetched) or `"html"` (direct ingestion) |
| `markdown` | string | The converted Markdown content |
| `meta.title` | string \| null | Page title (if available) |
| `meta.original_length` | number | Original HTML size in bytes |
| `meta.clean_length` | number | Final Markdown size in bytes |
| `meta.token_savings_percentage` | number | Percentage of bytes saved |

### Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `MISSING_INPUT` | Neither `url` nor `html` provided |
| 400 | `INVALID_URL` | URL format is invalid |
| 400 | `INVALID_BASE_URL` | `base_url` format is invalid |
| 400 | `EMPTY_HTML` | Provided HTML content is empty |
| 403 | `FORBIDDEN` | Missing or invalid authentication |
| 404 | `PAGE_NOT_FOUND` | Target page not found |
| 405 | `METHOD_NOT_ALLOWED` | Only GET/POST supported |
| 413 | `PAGE_TOO_LARGE` | Page or HTML exceeds 2MB limit |
| 502 | `FETCH_ERROR` | Failed to fetch target page |
| 504 | `TIMEOUT` | Request timed out (>8 seconds) |

## Self-Hosting

### Prerequisites

- Node.js 18+
- Vercel CLI (`npm i -g vercel`)

### Environment Variables

Create a `.env` file or set in Vercel dashboard:

```env
RAPIDAPI_SECRET=your-rapidapi-proxy-secret
ADMIN_SECRET=your-personal-admin-key
```

### Local Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev
```

### Deploy to Vercel

```bash
# Deploy to production
npm run deploy
```

## What Gets Removed

The API aggressively removes non-content elements:

- **Scripts & Styles:** `<script>`, `<style>`, `<noscript>`, inline styles
- **Navigation:** `<nav>`, `<header>`, `<footer>`, menus, breadcrumbs
- **Media:** `<iframe>`, `<video>`, `<audio>`, `<canvas>`, SVGs
- **Ads:** `.ad`, `.ads`, `.advertisement`, `.sponsored`, Google ads
- **Popups:** `.modal`, `.popup`, `.overlay`, `.lightbox`
- **Cookies:** `.cookie-consent`, `.gdpr`, `.privacy-banner`
- **Social:** `.social-share`, `.share-buttons`, social icons
- **Comments:** `.comments`, Disqus, comment sections
- **Related:** `.related-posts`, `.recommended`, suggestions
- **ARIA Hidden:** `[aria-hidden="true"]`, `[role="complementary"]`

## Use Cases

### RAG Pipelines

Feed clean content directly into your retrieval-augmented generation systems without pre-processing.

### AI Summarization

Get token-efficient content for GPT-4, Claude, or other LLMs to summarize.

### Content Archiving

Store clean, readable versions of web pages without the cruft.

### Data Extraction

Clean HTML makes subsequent parsing and data extraction more reliable.

## Limits

| Tier | Timeout | Max Page Size | Rate Limit |
|------|---------|---------------|------------|
| Free | 8s | 2MB | 50/month |
| Pro | 8s | 5MB | 10,000/month |
| Business | 15s | 10MB | 100,000/month |

## License

MIT
