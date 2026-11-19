import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { tables, strikethrough } from 'turndown-plugin-gfm';
import { lookup } from 'dns/promises';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Toggle to enable/disable size limit.
 * Set to `false` for upgraded tiers with higher limits.
 */
const ENABLE_SIZE_LIMIT = true;

/**
 * Maximum content length in bytes (2MB).
 * Prevents memory exhaustion on Vercel Free Tier.
 */
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;

/**
 * Axios timeout in milliseconds.
 * Set to 8 seconds to allow 2 seconds buffer before Vercel's 10s hard limit.
 */
const AXIOS_TIMEOUT = 8000;

/**
 * User-Agent string to mimic a real browser.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

/**
 * Blocked hostnames for SSRF protection.
 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
];

/**
 * Dangerous URI schemes to sanitize (XSS protection).
 */
const DANGEROUS_URI_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
];

/**
 * Selectors for elements to remove during HTML cleaning.
 * Aggressive cleaning to maximize token savings.
 */
const JUNK_SELECTORS = [
  // Scripts and styles
  'script',
  'style',
  'noscript',
  'link',
  'meta',
  'head',

  // Media and embeds
  'svg',
  'path',
  'iframe',
  'video',
  'audio',
  'canvas',
  'embed',
  'object',
  'picture',
  'source',

  // Navigation and layout
  'nav',
  'footer',
  'header',
  'sidebar',
  'aside',

  // Ads and tracking
  '.ad',
  '.ads',
  '.advert',
  '.advertisement',
  '.ad-container',
  '.ad-wrapper',
  '.ad-banner',
  '.google-ad',
  '.sponsored',

  // Cookie and consent banners
  '.cookie-consent',
  '.cookie-banner',
  '.cookie-notice',
  '.cookie-popup',
  '.gdpr',
  '.consent-banner',
  '.privacy-banner',

  // Social and sharing
  '.social-share',
  '.social-links',
  '.share-buttons',
  '.share-container',
  '.social-icons',

  // Related content and recommendations
  '.related-posts',
  '.related-articles',
  '.recommended',
  '.suggestions',
  '.more-stories',

  // Comments and interactions
  '.comments',
  '.comment-section',
  '.disqus',
  '#comments',

  // Modals and popups
  '.modal',
  '.popup',
  '.overlay',
  '.lightbox',
  '.dialog',

  // Navigation elements
  '.breadcrumb',
  '.breadcrumbs',
  '.pagination',
  '.nav-menu',
  '.menu',
  '.navbar',
  '.sidebar',
  '.toc',
  '.table-of-contents',

  // Miscellaneous junk
  '.newsletter',
  '.subscribe',
  '.signup',
  '.cta',
  '.banner',
  '.promo',
  '.announcement',
  '.alert',
  '.notice',
  '.widget',
  '.skip-link',
  '.screen-reader-text',

  // ARIA and accessibility hidden content
  '[role="banner"]',
  '[role="navigation"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',

  // Data attributes commonly used for non-content
  '[data-ad]',
  '[data-advertisement]',
  '[data-tracking]',
].join(', ');

// =============================================================================
// TYPES
// =============================================================================

interface ApiResponse {
  url: string | null;
  source: 'url' | 'html';
  markdown: string;
  meta: {
    title: string | null;
    original_length: number;
    clean_length: number;
    token_savings_percentage: number;
  };
}

interface ErrorResponse {
  error: string;
  message: string;
  code: number;
}

const CONVERSION_QUERY_PARAMS = new Set(['url', 'html', 'base_url']);

const LANDING_INFO = {
  service: 'web-to-markdown-api',
  description:
    'Convert public web pages or raw HTML into clean, LLM-ready Markdown for RAG and AI context windows.',
  status: 'ok',
  authentication: {
    required_for_conversion: true,
    mode: 'fail-closed',
    headers: ['x-rapidapi-proxy-secret', 'x-admin-key'],
  },
  endpoints: [
    {
      method: 'GET',
      path: '/',
      auth_required: false,
      description: 'Public API overview (returns HTML for browsers or JSON for API clients).',
    },
    {
      method: 'GET',
      path: '/?url=<encoded_url>',
      auth_required: true,
      description: 'Fetch a public HTTP/HTTPS web page and return cleaned Markdown.',
    },
    {
      method: 'POST',
      path: '/',
      auth_required: true,
      content_types: ['application/json', 'text/html', 'text/plain'],
      description:
        'Convert a target URL ({"url": "..."}) or raw HTML ({"html": "...", "base_url": "..."} or text/html body) into Markdown.',
    },
  ],
  usage: {
    get_url:
      "curl -G 'https://web-to-markdown-api.vercel.app/' --data-urlencode 'url=https://example.com/article' -H 'x-rapidapi-proxy-secret: YOUR_SECRET'",
    post_json:
      'curl -X POST \'https://web-to-markdown-api.vercel.app/\' -H \'Content-Type: application/json\' -H \'x-rapidapi-proxy-secret: YOUR_SECRET\' -d \'{"url":"https://example.com/article"}\'',
    post_html:
      "curl -X POST 'https://web-to-markdown-api.vercel.app/' -H 'Content-Type: text/html' -H 'x-rapidapi-proxy-secret: YOUR_SECRET' --data-binary @page.html",
  },
};

const LANDING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Web to Markdown API</title>
    <link rel="icon" href="data:," />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0b1020;
        --panel: #131a2e;
        --border: #26314f;
        --text: #e6ebf5;
        --muted: #9aa7c2;
        --accent: #60a5fa;
        --code-bg: #080c18;
        --badge-bg: #122b24;
        --badge-text: #4ade80;
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg: #f6f8fc;
          --panel: #ffffff;
          --border: #dce3f0;
          --text: #111827;
          --muted: #4b5563;
          --accent: #2563eb;
          --code-bg: #f1f5f9;
          --badge-bg: #dcfce7;
          --badge-text: #166534;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.6;
        padding: 2rem 1rem;
      }
      main {
        max-width: 820px;
        margin: 0 auto;
        display: grid;
        gap: 1.25rem;
      }
      section, header {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1.25rem 1.5rem;
      }
      h1 { margin: 0 0 0.4rem; font-size: 1.65rem; }
      h2 { margin: 0 0 0.75rem; font-size: 1.1rem; }
      p { margin: 0.4rem 0; color: var(--muted); }
      .badge {
        display: inline-block;
        padding: 0.2rem 0.6rem;
        border-radius: 999px;
        font-size: 0.8rem;
        font-weight: 600;
        background: var(--badge-bg);
        color: var(--badge-text);
        margin-bottom: 0.6rem;
      }
      ul { margin: 0.5rem 0 0; padding-left: 1.25rem; }
      li { margin: 0.45rem 0; }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.9em;
        background: var(--code-bg);
        padding: 0.15rem 0.4rem;
        border-radius: 5px;
      }
      pre {
        margin: 0.5rem 0 0;
        padding: 0.9rem 1rem;
        background: var(--code-bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow-x: auto;
        font-size: 0.85rem;
        line-height: 1.5;
      }
      pre code { background: none; padding: 0; }
      .endpoint-method {
        font-weight: 700;
        color: var(--accent);
        margin-right: 0.35rem;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span class="badge">HTTP 200 · Service Online</span>
        <h1>Web to Markdown API</h1>
        <p>Convert public web pages or raw HTML into clean, dense Markdown optimized for LLM ingestion and RAG context windows.</p>
      </header>

      <section>
        <h2>Authentication</h2>
        <p>All conversion requests are <strong>fail-closed</strong> and require a valid credential header:</p>
        <ul>
          <li><code>x-rapidapi-proxy-secret</code> — RapidAPI proxy secret</li>
          <li><code>x-admin-key</code> — Admin API key</li>
        </ul>
      </section>

      <section>
        <h2>Endpoints</h2>
        <ul>
          <li><span class="endpoint-method">GET</span><code>/</code> — Public service overview (HTML in browsers, JSON when <code>Accept: application/json</code> is requested).</li>
          <li><span class="endpoint-method">GET</span><code>/?url=&lt;encoded_url&gt;</code> — Fetch a public HTTP/HTTPS URL and return cleaned Markdown JSON. <em>(Auth required)</em></li>
          <li><span class="endpoint-method">POST</span><code>/</code> — Send JSON (<code>{"url": "..."}</code> or <code>{"html": "...", "base_url": "..."}</code>) or raw HTML (<code>Content-Type: text/html</code>). <em>(Auth required)</em></li>
        </ul>
      </section>

      <section>
        <h2>Usage Examples</h2>
        <p>Fetch and convert a public URL:</p>
        <pre><code>curl -G 'https://web-to-markdown-api.vercel.app/' \\
  --data-urlencode 'url=https://example.com/article' \\
  -H 'x-rapidapi-proxy-secret: YOUR_SECRET'</code></pre>
        <p>Convert via JSON POST:</p>
        <pre><code>curl -X POST 'https://web-to-markdown-api.vercel.app/' \\
  -H 'Content-Type: application/json' \\
  -H 'x-rapidapi-proxy-secret: YOUR_SECRET' \\
  -d '{"url":"https://example.com/article"}'</code></pre>
        <p>Convert raw HTML directly:</p>
        <pre><code>curl -X POST 'https://web-to-markdown-api.vercel.app/' \\
  -H 'Content-Type: text/html' \\
  -H 'x-rapidapi-proxy-secret: YOUR_SECRET' \\
  --data-binary @page.html</code></pre>
      </section>
    </main>
  </body>
</html>`;

interface FetchValidationResult {
  ok: boolean;
  finalUrl?: URL;
  contentType?: string;
  reason?: string;
}

// =============================================================================
// SECURITY: GATEKEEPER PATTERN
// =============================================================================

/**
 * Validates incoming requests against allowed authentication headers.
 * Returns true if the request is authorized, false otherwise.
 */
function validateAuth(
  req: VercelRequest
): { allowed: boolean; statusCode?: number; message?: string } {
  const rapidApiSecret = process.env.RAPIDAPI_SECRET;
  const adminSecret = process.env.ADMIN_SECRET;
  const allowUnauthenticatedDev = process.env.ALLOW_UNAUTHENTICATED_DEV === 'true';

  // Get headers (case-insensitive)
  const rapidApiHeader = req.headers['x-rapidapi-proxy-secret'] as string | undefined;
  const adminHeader = req.headers['x-admin-key'] as string | undefined;

  // Check RapidAPI secret (for paying customers)
  if (rapidApiSecret && rapidApiHeader === rapidApiSecret) {
    return { allowed: true };
  }

  // Check Admin secret (for local testing/personal use)
  if (adminSecret && adminHeader === adminSecret) {
    return { allowed: true };
  }

  if (!rapidApiSecret && !adminSecret) {
    if (allowUnauthenticatedDev) {
      return { allowed: true };
    }

    return {
      allowed: false,
      statusCode: 503,
      message:
        'Server authentication is not configured. Set RAPIDAPI_SECRET or ADMIN_SECRET, or ALLOW_UNAUTHENTICATED_DEV=true for local-only testing.',
    };
  }

  return {
    allowed: false,
    statusCode: 403,
    message: 'Invalid or missing authentication credentials',
  };
}

function getClientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  return 'unknown';
}

function checkRateLimit(clientIp: string): {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || RATE_LIMIT_WINDOW_MS);
  const limit = Number(process.env.RATE_LIMIT_MAX || RATE_LIMIT_MAX_REQUESTS);
  const current = rateLimitStore.get(clientIp);

  if (!current || current.resetAt <= now) {
    rateLimitStore.set(clientIp, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      remaining: Math.max(limit - 1, 0),
      limit,
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  current.count += 1;
  rateLimitStore.set(clientIp, current);
  const retryAfterSeconds = Math.max(Math.ceil((current.resetAt - now) / 1000), 1);

  return {
    allowed: current.count <= limit,
    remaining: Math.max(limit - current.count, 0),
    limit,
    retryAfterSeconds,
  };
}

// =============================================================================
// HTML CLEANING
// =============================================================================

/**
 * Aggressively cleans HTML by removing non-content elements.
 * Returns the cleaned HTML and extracted metadata.
 */
function cleanHtml(
  html: string,
  baseUrl?: string
): { cleanedHtml: string; title: string | null } {
  const $ = cheerio.load(html);

  // Extract title before cleaning
  const title = $('title').first().text().trim() || null;

  // Remove all junk elements
  $(JUNK_SELECTORS).remove();

  // Remove empty elements that add no value
  $('div, span, p').each((_, el) => {
    const $el = $(el);
    if ($el.text().trim() === '' && $el.children().length === 0) {
      $el.remove();
    }
  });

  // Remove all HTML comments
  $('*')
    .contents()
    .filter(function () {
      return this.type === 'comment';
    })
    .remove();

  // Remove inline styles and event handlers
  $('*').removeAttr('style');
  $('*').removeAttr('onclick');
  $('*').removeAttr('onload');
  $('*').removeAttr('onerror');

  // ==========================================================================
  // XSS PROTECTION: Sanitize dangerous URI schemes in links
  // ==========================================================================
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim().toLowerCase();

    // Check for dangerous URI schemes
    const isDangerous = DANGEROUS_URI_SCHEMES.some((scheme) =>
      href.startsWith(scheme)
    );

    if (isDangerous) {
      // Remove the href attribute entirely to neutralize the link
      $el.removeAttr('href');
    }
  });

  // Also sanitize form actions
  $('form[action]').each((_, el) => {
    const $el = $(el);
    const action = ($el.attr('action') || '').trim().toLowerCase();

    const isDangerous = DANGEROUS_URI_SCHEMES.some((scheme) =>
      action.startsWith(scheme)
    );

    if (isDangerous) {
      $el.removeAttr('action');
    }
  });

  // Resolve relative links to absolute URLs so the Markdown is
  // self-contained when ingested out of context
  if (baseUrl) {
    $('a[href]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href || href.startsWith('#')) return;
      try {
        $el.attr('href', new URL(href, baseUrl).href);
      } catch {
        // Leave unresolvable hrefs as-is
      }
    });
  }

  // Get the body content, or fall back to the entire document
  const body = $('body').html() || $.html();

  return {
    cleanedHtml: body,
    title,
  };
}

// =============================================================================
// MARKDOWN CONVERSION
// =============================================================================

/**
 * Converts cleaned HTML to Markdown using Turndown.
 */
function convertToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    linkReferenceStyle: 'full',
  });

  // GFM tables and strikethrough so tabular data keeps its structure
  turndownService.use([tables, strikethrough]);

  // Remove images to save tokens (optional: could be made configurable)
  turndownService.addRule('removeImages', {
    filter: 'img',
    replacement: () => '',
  });

  // Clean up links with no text
  turndownService.addRule('cleanLinks', {
    filter: (node) => {
      return (
        node.nodeName === 'A' &&
        (!node.textContent || node.textContent.trim() === '')
      );
    },
    replacement: () => '',
  });

  const markdown = turndownService.turndown(html);

  // Post-process: remove excessive whitespace
  return markdown
    .replace(/^(\s*)-\s+/gm, '$1- ') // Single space after list markers (saves tokens)
    .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
    .replace(/[ \t]+$/gm, '') // Remove trailing whitespace
    .trim();
}

// =============================================================================
// URL VALIDATION
// =============================================================================

/**
 * Validates and normalizes a URL string.
 */
function validateUrl(urlString: string): URL | null {
  try {
    const url = new URL(urlString);
    // Only allow http and https protocols
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

// =============================================================================
// SSRF PROTECTION
// =============================================================================

/**
 * Checks if an IP address is private/internal (RFC 1918, loopback, link-local, etc.)
 */
function isPrivateIP(ip: string): boolean {
  // Handle IPv4
  const ipv4Parts = ip.split('.').map(Number);
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => p >= 0 && p <= 255)) {
    const [a, b, c, d] = ipv4Parts;

    // Loopback: 127.0.0.0/8
    if (a === 127) return true;

    // Private: 10.0.0.0/8
    if (a === 10) return true;

    // Private: 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;

    // Private: 192.168.0.0/16
    if (a === 192 && b === 168) return true;

    // Link-local: 169.254.0.0/16 (includes AWS metadata endpoint)
    if (a === 169 && b === 254) return true;

    // Current network: 0.0.0.0/8
    if (a === 0) return true;

    // Broadcast
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;

    // CGNAT: 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) return true;

    return false;
  }

  // Handle IPv6
  const ipv6Lower = ip.toLowerCase();

  // Loopback: ::1
  if (ipv6Lower === '::1' || ipv6Lower === '0:0:0:0:0:0:0:1') return true;

  // Unspecified: ::
  if (ipv6Lower === '::' || ipv6Lower === '0:0:0:0:0:0:0:0') return true;

  // Link-local: fe80::/10
  if (ipv6Lower.startsWith('fe80:') || ipv6Lower.startsWith('fe80')) return true;

  // Unique local: fc00::/7 (fd00::/8 commonly used)
  if (ipv6Lower.startsWith('fc') || ipv6Lower.startsWith('fd')) return true;

  // IPv4-mapped IPv6: ::ffff:x.x.x.x
  const ipv4MappedMatch = ipv6Lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4MappedMatch) {
    return isPrivateIP(ipv4MappedMatch[1]);
  }

  return false;
}

/**
 * Validates that a URL does not point to a private/internal address.
 * Resolves DNS and checks the resulting IP against blocked ranges.
 */
async function validateUrlNotPrivate(url: URL): Promise<{ safe: boolean; reason?: string }> {
  const hostname = url.hostname;

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.includes(hostname.toLowerCase())) {
    return { safe: false, reason: 'Hostname is blocked' };
  }

  // Check if hostname is already an IP address
  const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  const isIPv6 = hostname.includes(':');

  if (isIPv4 || isIPv6) {
    // Direct IP address - check immediately
    const cleanIP = hostname.replace(/^\[|\]$/g, ''); // Remove IPv6 brackets
    if (isPrivateIP(cleanIP)) {
      return { safe: false, reason: 'Direct access to private IP addresses is not allowed' };
    }
    return { safe: true };
  }

  // Resolve DNS to get IP address
  try {
    const result = await lookup(hostname, { all: true });

    // Check all resolved IPs
    for (const entry of result) {
      if (isPrivateIP(entry.address)) {
        return {
          safe: false,
          reason: `Hostname resolves to private IP address (${entry.address})`,
        };
      }
    }

    return { safe: true };
  } catch (error) {
    // DNS resolution failed - could be invalid hostname
    const message = error instanceof Error ? error.message : 'Unknown DNS error';
    return { safe: false, reason: `DNS resolution failed: ${message}` };
  }
}

/**
 * Validates the final fetched URL after redirects and checks the response content type.
 */
async function validateFetchedResponse(
  finalUrlRaw: string,
  contentTypeHeader: string | undefined
): Promise<FetchValidationResult> {
  const finalUrl = validateUrl(finalUrlRaw);
  if (!finalUrl) {
    return { ok: false, reason: 'Final redirect target is not a valid HTTP or HTTPS URL' };
  }

  const ssrfCheck = await validateUrlNotPrivate(finalUrl);
  if (!ssrfCheck.safe) {
    return { ok: false, reason: ssrfCheck.reason || 'Redirect target is not allowed' };
  }

  const normalizedContentType = (contentTypeHeader || '').toLowerCase();
  const isHtml =
    normalizedContentType.includes('text/html') ||
    normalizedContentType.includes('application/xhtml+xml');

  if (!isHtml) {
    return {
      ok: false,
      finalUrl,
      contentType: normalizedContentType,
      reason: `Fetched content is not HTML (received ${contentTypeHeader || 'unknown content-type'})`,
    };
  }

  return {
    ok: true,
    finalUrl,
    contentType: normalizedContentType,
  };
}

// =============================================================================
// PUBLIC LANDING HELPERS
// =============================================================================

function getRequestPathname(req: VercelRequest): string {
  if (!req.url) {
    return '/';
  }

  try {
    return new URL(req.url, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

function hasConversionQueryParam(req: VercelRequest): boolean {
  const query = req.query || {};
  for (const [key, value] of Object.entries(query)) {
    if (CONVERSION_QUERY_PARAMS.has(key.toLowerCase()) && value !== undefined) {
      return true;
    }
  }

  if (req.url) {
    try {
      const searchParams = new URL(req.url, 'http://localhost').searchParams;
      for (const key of searchParams.keys()) {
        if (CONVERSION_QUERY_PARAMS.has(key.toLowerCase())) {
          return true;
        }
      }
    } catch {
      // Malformed req.url cannot match root path anyway
    }
  }

  return false;
}

function hasAnyAuthHeader(req: VercelRequest): boolean {
  return (
    req.headers['x-rapidapi-proxy-secret'] !== undefined ||
    req.headers['x-admin-key'] !== undefined
  );
}

/**
 * Returns true only for unauthenticated bare GET / requests with no
 * conversion query parameters (such as a browser visiting the root URL).
 */
function isBarePublicRootGet(req: VercelRequest): boolean {
  return (
    req.method === 'GET' &&
    getRequestPathname(req) === '/' &&
    !hasConversionQueryParam(req) &&
    !hasAnyAuthHeader(req)
  );
}

function prefersHtmlResponse(req: VercelRequest): boolean {
  const acceptHeader = req.headers.accept;
  const accept = (
    Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader || ''
  ).toLowerCase();

  const htmlIndex = accept.indexOf('text/html');
  if (htmlIndex === -1) {
    return false;
  }

  const jsonIndex = accept.indexOf('application/json');
  return jsonIndex === -1 || htmlIndex < jsonIndex;
}

function sendLandingResponse(req: VercelRequest, res: VercelResponse): void {
  res.setHeader('Vary', 'Accept');

  if (prefersHtmlResponse(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(LANDING_HTML);
    return;
  }

  res.status(200).json(LANDING_INFO);
}

// =============================================================================
// ERROR RESPONSE HELPER
// =============================================================================

/**
 * Sends a standardized error response.
 */
function sendError(
  res: VercelResponse,
  code: number,
  error: string,
  message: string
): void {
  const response: ErrorResponse = { error, message, code };
  res.status(code).json(response);
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-rapidapi-proxy-secret, x-admin-key');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET and POST methods are supported');
    return;
  }

  // Serve informational landing response only for unauthenticated bare GET /
  if (isBarePublicRootGet(req)) {
    sendLandingResponse(req, res);
    return;
  }

  // ==========================================================================
  // SECURITY CHECK
  // ==========================================================================
  const authResult = validateAuth(req);
  if (!authResult.allowed) {
    sendError(
      res,
      authResult.statusCode || 403,
      'FORBIDDEN',
      authResult.message || 'Invalid or missing authentication credentials'
    );
    return;
  }

  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);
  res.setHeader('X-RateLimit-Limit', String(rateLimit.limit));
  res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
  res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));

  if (!rateLimit.allowed) {
    sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
    return;
  }

  // ==========================================================================
  // EXTRACT INPUT: raw HTML (direct ingestion) or URL (fetch mode)
  // ==========================================================================
  let targetUrl: string | undefined;
  let rawHtml: string | undefined;
  let baseUrl: string | undefined;

  if (req.method === 'GET') {
    targetUrl = req.query.url as string | undefined;
  } else {
    const contentType = (req.headers['content-type'] || '').toLowerCase();

    if (contentType.includes('text/html') || contentType.includes('text/plain')) {
      // Raw HTML document posted directly (e.g. curl --data-binary @page.html)
      rawHtml = typeof req.body === 'string' ? req.body : undefined;
      baseUrl = req.query.base_url as string | undefined;
    } else {
      // JSON body: { "html": "..." } or { "url": "..." }
      rawHtml = req.body?.html as string | undefined;
      baseUrl =
        (req.body?.base_url as string | undefined) ||
        (req.query.base_url as string | undefined);
      targetUrl =
        (req.body?.url as string | undefined) || (req.query.url as string | undefined);
    }
  }

  if (!targetUrl && !rawHtml) {
    sendError(
      res,
      400,
      'MISSING_INPUT',
      'Provide a "url" parameter to fetch, an "html" field with raw HTML, or POST an HTML document with Content-Type: text/html'
    );
    return;
  }

  // ==========================================================================
  // MODE 1: DIRECT HTML INGESTION (no fetching, no SSRF surface)
  // ==========================================================================
  if (rawHtml !== undefined) {
    if (rawHtml.trim() === '') {
      sendError(res, 400, 'EMPTY_HTML', 'The provided HTML content is empty');
      return;
    }

    const htmlLength = Buffer.byteLength(rawHtml, 'utf8');
    if (ENABLE_SIZE_LIMIT && htmlLength > MAX_CONTENT_LENGTH) {
      sendError(res, 413, 'PAGE_TOO_LARGE', 'HTML exceeds the 2MB size limit for free tier');
      return;
    }

    // Optional base URL used only to resolve relative links in the output
    let resolvedBase: string | undefined;
    if (baseUrl) {
      const validatedBase = validateUrl(baseUrl);
      if (!validatedBase) {
        sendError(res, 400, 'INVALID_BASE_URL', 'The "base_url" must be a valid HTTP or HTTPS URL');
        return;
      }
      resolvedBase = validatedBase.href;
    }

    try {
      const { cleanedHtml, title } = cleanHtml(rawHtml, resolvedBase);
      const markdown = convertToMarkdown(cleanedHtml);
      const cleanLength = Buffer.byteLength(markdown, 'utf8');
      const tokenSavingsPercentage =
        htmlLength > 0
          ? Math.round(((htmlLength - cleanLength) / htmlLength) * 100)
          : 0;

      const response: ApiResponse = {
        url: resolvedBase || null,
        source: 'html',
        markdown,
        meta: {
          title,
          original_length: htmlLength,
          clean_length: cleanLength,
          token_savings_percentage: Math.max(0, tokenSavingsPercentage),
        },
      };

      res.status(200).json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendError(res, 500, 'PROCESSING_ERROR', `Failed to process the HTML: ${message}`);
    }
    return;
  }

  // ==========================================================================
  // MODE 2: URL FETCH
  // ==========================================================================
  if (!targetUrl) {
    sendError(res, 400, 'MISSING_INPUT', 'The "url" parameter is required');
    return;
  }

  // Validate URL format
  const validatedUrl = validateUrl(targetUrl);
  if (!validatedUrl) {
    sendError(res, 400, 'INVALID_URL', 'The provided URL is not valid. Must be a valid HTTP or HTTPS URL.');
    return;
  }

  // ==========================================================================
  // SSRF PROTECTION: Validate URL does not target internal/private addresses
  // ==========================================================================
  const ssrfCheck = await validateUrlNotPrivate(validatedUrl);
  if (!ssrfCheck.safe) {
    sendError(res, 403, 'SSRF_BLOCKED', ssrfCheck.reason || 'Access to this URL is not allowed');
    return;
  }

  // ==========================================================================
  // FETCH THE PAGE
  // ==========================================================================
  let html: string;
  let originalLength: number;

  try {
    const axiosConfig: Parameters<typeof axios.get>[1] = {
      timeout: AXIOS_TIMEOUT,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      responseType: 'text',
      maxRedirects: 5,
    };

    // Apply size limits if enabled
    if (ENABLE_SIZE_LIMIT) {
      axiosConfig.maxContentLength = MAX_CONTENT_LENGTH;
      axiosConfig.maxBodyLength = MAX_CONTENT_LENGTH;
    }

    const response = await axios.get(validatedUrl.href, axiosConfig);
    const finalUrlRaw = response.request?.res?.responseUrl || validatedUrl.href;
    const fetchValidation = await validateFetchedResponse(
      finalUrlRaw,
      response.headers['content-type'] as string | undefined
    );

    if (!fetchValidation.ok) {
      sendError(
        res,
        403,
        'FETCH_BLOCKED',
        fetchValidation.reason || 'Fetched response failed security validation'
      );
      return;
    }

    html = response.data;
    originalLength = Buffer.byteLength(html, 'utf8');
  } catch (error) {
    if (error instanceof AxiosError) {
      // Handle specific Axios errors
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        sendError(res, 504, 'TIMEOUT', 'The request timed out while fetching the page');
        return;
      }

      if (error.response?.status === 404) {
        sendError(res, 404, 'PAGE_NOT_FOUND', 'The requested page was not found');
        return;
      }

      if (error.message.includes('maxContentLength') || error.message.includes('maxBodyLength')) {
        sendError(res, 413, 'PAGE_TOO_LARGE', 'Page exceeds the 2MB size limit for free tier');
        return;
      }

      // Generic fetch error
      sendError(
        res,
        502,
        'FETCH_ERROR',
        `Failed to fetch the page: ${error.message}`
      );
      return;
    }

    // Unknown error
    sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    return;
  }

  // ==========================================================================
  // CLEAN AND CONVERT
  // ==========================================================================
  try {
    // Clean the HTML, resolving relative links against the fetched URL
    const { cleanedHtml, title } = cleanHtml(html, validatedUrl.href);

    // Convert to Markdown
    const markdown = convertToMarkdown(cleanedHtml);

    // Calculate metrics
    const cleanLength = Buffer.byteLength(markdown, 'utf8');
    const tokenSavingsPercentage =
      originalLength > 0
        ? Math.round(((originalLength - cleanLength) / originalLength) * 100)
        : 0;

    // Build response
    const response: ApiResponse = {
      url: validatedUrl.href,
      source: 'url',
      markdown,
      meta: {
        title,
        original_length: originalLength,
        clean_length: cleanLength,
        token_savings_percentage: Math.max(0, tokenSavingsPercentage),
      },
    };

    res.status(200).json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    sendError(res, 500, 'PROCESSING_ERROR', `Failed to process the page: ${message}`);
  }
}

export const __testables = {
  isPrivateIP,
  validateUrlNotPrivate,
  validateFetchedResponse,
  validateUrl,
  cleanHtml,
  convertToMarkdown,
  validateAuth,
  checkRateLimit,
  resetRateLimitStore: () => rateLimitStore.clear(),
};
