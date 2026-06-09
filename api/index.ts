import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
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

// =============================================================================
// SECURITY: GATEKEEPER PATTERN
// =============================================================================

/**
 * Validates incoming requests against allowed authentication headers.
 * Returns true if the request is authorized, false otherwise.
 */
function validateAuth(req: VercelRequest): boolean {
  const rapidApiSecret = process.env.RAPIDAPI_SECRET;
  const adminSecret = process.env.ADMIN_SECRET;

  // Get headers (case-insensitive)
  const rapidApiHeader = req.headers['x-rapidapi-proxy-secret'] as string | undefined;
  const adminHeader = req.headers['x-admin-key'] as string | undefined;

  // Check RapidAPI secret (for paying customers)
  if (rapidApiSecret && rapidApiHeader === rapidApiSecret) {
    return true;
  }

  // Check Admin secret (for local testing/personal use)
  if (adminSecret && adminHeader === adminSecret) {
    return true;
  }

  return false;
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

  // ==========================================================================
  // SECURITY CHECK
  // ==========================================================================
  if (!validateAuth(req)) {
    sendError(res, 403, 'FORBIDDEN', 'Invalid or missing authentication credentials');
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
