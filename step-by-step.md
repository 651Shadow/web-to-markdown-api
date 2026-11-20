# RapidAPI Listing Setup Guide

This guide walks you through publishing the **LLM-Ready Web Reader** API on RapidAPI Marketplace.

---

## Prerequisites

Before starting, ensure you have:

- [ ] A deployed Vercel API (e.g., `https://web-to-markdown-api.vercel.app`)
- [ ] A RapidAPI account (sign up at [rapidapi.com](https://rapidapi.com))
- [ ] Your `RAPIDAPI_SECRET` value (you'll generate this during setup)

---

## Step 1: Create a RapidAPI Provider Account

1. Go to [RapidAPI Provider Dashboard](https://rapidapi.com/provider)
2. Click **"Add New API"**
3. Select **"Add Existing API"** (since your API is already deployed on Vercel)

---

## Step 2: Basic API Information

Fill in the following fields:

| Field | Value |
|-------|-------|
| **API Name** | `LLM-Ready Web Reader` |
| **Short Description** | `Convert any URL into clean Markdown optimized for LLMs. Save up to 60% on token costs.` |
| **Category** | `Text Analysis` or `Data` |
| **Website** | Your GitHub repo or landing page URL |

### Long Description (Markdown supported)

```markdown
## Stop Wasting Money on OpenAI Tokens

When feeding web content to LLMs, you're paying for every token—including useless HTML tags, navigation menus, ads, cookie banners, and tracking scripts.

**LLM-Ready Web Reader** strips all that away, delivering only the content that matters.

### Key Features

- **60% Token Savings** - Aggressive HTML cleaning removes junk
- **LLM-Optimized Output** - Clean Markdown perfect for RAG pipelines
- **Fast & Reliable** - Sub-second response times
- **Metadata Included** - Page title and token savings percentage

### Use Cases

- RAG (Retrieval-Augmented Generation) pipelines
- AI summarization and analysis
- Content archiving
- Web research automation

### Response Example

```json
{
  "url": "https://example.com/",
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
```

---

## Step 3: Configure Base URL

1. Navigate to **"Settings"** → **"Base URL"**
2. Enter your Vercel deployment URL:

```
https://web-to-markdown-api.vercel.app
```

> **Note:** Do NOT include a trailing slash

---

## Step 4: Add the Endpoints

Go to **"Endpoints"** and click **"Create Endpoint"**

### Endpoint 1: Convert URL to Markdown (`GET /`)

| Field | Value |
|-------|-------|
| **Name** | `Convert URL to Markdown` |
| **Description** | `Converts a web page URL into clean, LLM-optimized Markdown` |
| **Method** | `GET` |
| **Endpoint Path** | `/` |

#### Query Parameters

| Parameter Name | Type | Required | Description |
|----------------|------|----------|-------------|
| `url` | `string` | Yes | The full HTTP/HTTPS URL of the web page to convert |

### Endpoint 2: Convert URL or Raw HTML (`POST /`)

| Field | Value |
|-------|-------|
| **Name** | `Convert URL or Raw HTML to Markdown` |
| **Description** | `Converts either a JSON payload ({ "url" } or { "html", "base_url" }) or a raw Content-Type: text/html body into Markdown` |
| **Method** | `POST` |
| **Endpoint Path** | `/` |

---

## Step 5: Configure Authentication (Critical)

This is the most important step for security.

### 5.1: Set Up Proxy Secret

1. Go to **"Settings"** → **"Security"**
2. Find **"Secret/Key Authentication"** or **"Proxy Secret"**
3. Enable **"X-RapidAPI-Proxy-Secret"**
4. RapidAPI will generate a secret value - **copy this value**

### 5.2: Add Secret to Vercel

1. Go to your [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project → **"Settings"** → **"Environment Variables"**
3. Add the following:

| Name | Value | Environment |
|------|-------|-------------|
| `RAPIDAPI_SECRET` | `<paste the secret from RapidAPI>` | Production |
| `ADMIN_SECRET` | `<your-personal-admin-key>` | Production |

4. Click **"Save"**
5. **Redeploy** your project for the env vars to take effect:
   - Go to "Deployments" tab
   - Click the three dots on the latest deployment
   - Select "Redeploy"

> **Important:** The `RAPIDAPI_SECRET` value must EXACTLY match what RapidAPI sends in the `x-rapidapi-proxy-secret` header.

---

## Step 6: Test the Endpoint

1. In RapidAPI, go to your endpoint
2. Click **"Test Endpoint"**
3. Enter a test URL: `https://example.com`
4. Click **"Test"**

### Expected Response (200 OK):

```json
{
  "url": "https://example.com/",
  "source": "url",
  "markdown": "# Example Domain\n\nThis domain is for use in illustrative examples in documents...",
  "meta": {
    "title": "Example Domain",
    "original_length": 1256,
    "clean_length": 298,
    "token_savings_percentage": 76
  }
}
```

### If You Get 403 Forbidden:

- Verify `RAPIDAPI_SECRET` in Vercel matches the RapidAPI proxy secret
- Ensure you redeployed after adding the environment variable
- Check that the header name is exactly `x-rapidapi-proxy-secret`

---

## Step 7: Configure Pricing Plans

Go to **"Monetization"** → **"Plans"**

### Free Plan (Basic)

| Field | Value |
|-------|-------|
| **Plan Name** | `Free` |
| **Price** | `$0/month` |
| **Rate Limit** | `50 requests/month` |
| **Quota Type** | `Monthly` |

### Pro Plan

| Field | Value |
|-------|-------|
| **Plan Name** | `Pro` |
| **Price** | `$9.99/month` |
| **Rate Limit** | `10,000 requests/month` |
| **Quota Type** | `Monthly` |

### Business Plan

| Field | Value |
|-------|-------|
| **Plan Name** | `Business` |
| **Price** | `$29.99/month` |
| **Rate Limit** | `100,000 requests/month` |
| **Quota Type** | `Monthly` |

---

## Step 8: Add API Documentation

### Error Codes

Go to **"Documentation"** and add error responses:

| Status Code | Error Code | Description |
|-------------|------------|-------------|
| `400` | `MISSING_INPUT` | Neither `url` nor `html` input was provided |
| `400` | `INVALID_INPUT` | Non-string input type, malformed JSON, or ambiguous dual `url` + `html` input |
| `400` | `EMPTY_HTML` | The provided HTML content is empty |
| `400` | `INVALID_URL` | The provided `url` is not a valid HTTP or HTTPS URL |
| `400` | `INVALID_BASE_URL` | The provided `base_url` is not a valid HTTP or HTTPS URL |
| `403` | `FORBIDDEN` | Invalid or missing authentication credentials |
| `403` | `SSRF_BLOCKED` | Target or redirect URL points to a blocked or private address |
| `404` | `PAGE_NOT_FOUND` | The target page was not found |
| `405` | `METHOD_NOT_ALLOWED` | Only `GET`, `POST`, and `OPTIONS` methods are supported |
| `413` | `PAGE_TOO_LARGE` | Page or HTML payload exceeds the 2MB size limit |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Fetched URL returned a non-HTML content type |
| `429` | `RATE_LIMITED` | Too many requests from the same client IP (`Retry-After` header included) |
| `500` | `PROCESSING_ERROR` | Failed to clean or convert the HTML document |
| `502` | `FETCH_ERROR` | Failed to fetch the target page or invalid upstream redirect |
| `503` | `AUTH_NOT_CONFIGURED` | Server auth secrets are not configured and `ALLOW_UNAUTHENTICATED_DEV` is not enabled |
| `504` | `TIMEOUT` | Request timed out (>8 seconds) |

### Response Schema

```json
{
  "url": {
    "type": ["string", "null"],
    "description": "The final resolved URL (after any redirects) or base_url, or null for raw HTML without base_url"
  },
  "source": {
    "type": "string",
    "enum": ["url", "html"],
    "description": "Indicates whether the Markdown was produced from a fetched URL or direct HTML ingestion"
  },
  "markdown": {
    "type": "string", 
    "description": "The converted Markdown content"
  },
  "meta": {
    "type": "object",
    "properties": {
      "title": {
        "type": ["string", "null"],
        "description": "Page title (if available)"
      },
      "original_length": {
        "type": "integer",
        "description": "Original HTML size in bytes"
      },
      "clean_length": {
        "type": "integer",
        "description": "Final Markdown size in bytes"
      },
      "token_savings_percentage": {
        "type": "integer",
        "description": "Percentage of bytes saved"
      }
    }
  }
}
```

---

## Step 9: Add Logo and Branding

1. Go to **"Settings"** → **"General"**
2. Upload an API logo (recommended: 200x200 PNG)
3. Add relevant tags: `markdown`, `llm`, `ai`, `rag`, `web-scraping`, `text-extraction`

---

## Step 10: Submit for Review

1. Review all settings and documentation
2. Go to **"Settings"** → **"Visibility"**
3. Change from **"Private"** to **"Public"**
4. Click **"Submit for Review"**

RapidAPI will review your API (usually 1-3 business days).

---

## Post-Launch Checklist

After your API is approved:

- [ ] Test all pricing tiers work correctly
- [ ] Monitor the RapidAPI analytics dashboard
- [ ] Set up error alerting in Vercel
- [ ] Respond to user reviews and questions

---

## Quick Reference: Environment Variables

| Variable | Where to Set | Purpose |
|----------|--------------|---------|
| `RAPIDAPI_SECRET` | Vercel | Validates requests from RapidAPI |
| `ADMIN_SECRET` | Vercel | Your personal testing key |
| `ALLOW_UNAUTHENTICATED_DEV` | Local `.env` only | Set to `true` only for local development without secrets |
| `RATE_LIMIT_MAX` | Vercel / `.env` | Max requests per window per IP (default `30`) |
| `RATE_LIMIT_WINDOW_MS` | Vercel / `.env` | Rate limit window in milliseconds (default `60000`) |

---

## Quick Reference: Headers

| Header | Source | Purpose |
|--------|--------|---------|
| `x-rapidapi-proxy-secret` | RapidAPI (automatic) | Authenticates paying customers |
| `x-admin-key` | Manual | Your personal testing access |

---

## Troubleshooting

### "403 Forbidden" on all requests
- Check `RAPIDAPI_SECRET` matches exactly
- Redeploy Vercel after adding env vars

### "504 Timeout" errors
- Target page is slow; nothing you can do
- Consider documenting this limitation

### "413 Page Too Large" errors
- Page exceeds 2MB limit
- This is by design for free tier

### Endpoint not showing in RapidAPI
- Ensure endpoint path is exactly `/`
- Check base URL has no trailing slash

---

## Support

- **GitHub Issues:** [github.com/651Shadow/web-to-markdown-api/issues](https://github.com/651Shadow/web-to-markdown-api/issues)
- **RapidAPI Support:** Use the built-in messaging system

---

**Congratulations!** Your API is now listed on RapidAPI Marketplace.
