import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

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
  url: string;
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
function cleanHtml(html: string): { cleanedHtml: string; title: string | null } {
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
  // EXTRACT URL PARAMETER
  // ==========================================================================
  let targetUrl: string | undefined;

  if (req.method === 'GET') {
    targetUrl = req.query.url as string | undefined;
  } else {
    // POST: check body first, then query params
    targetUrl = (req.body?.url as string | undefined) || (req.query.url as string | undefined);
  }

  if (!targetUrl) {
    sendError(res, 400, 'MISSING_URL', 'The "url" parameter is required');
    return;
  }

  // Validate URL format
  const validatedUrl = validateUrl(targetUrl);
  if (!validatedUrl) {
    sendError(res, 400, 'INVALID_URL', 'The provided URL is not valid. Must be a valid HTTP or HTTPS URL.');
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
    // Clean the HTML
    const { cleanedHtml, title } = cleanHtml(html);

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
