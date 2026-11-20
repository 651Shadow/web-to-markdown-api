import * as cheerio from 'cheerio';

const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Selectors for non-content elements removed during HTML cleaning.
 * Preserves semantic article/main headers (`body > header` only) and documentation
 * callout boxes (`.alert`, `.notice`).
 */
export const JUNK_SELECTORS = [
  // Scripts and styles
  'script',
  'style',
  'noscript',
  'link',
  'meta',
  'head',

  // Media and embeds
  'svg',
  'iframe',
  'video',
  'audio',
  'canvas',
  'embed',
  'object',
  'picture',
  'source',

  // Navigation and layout (scope header to top-level body > header so <article><header><h1> survives)
  'nav',
  'footer',
  'body > header',
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

/**
 * Cleans HTML by stripping non-content elements and normalizing `<a href>`
 * attributes in a single allowlist pass (`http:`, `https:`, `mailto:`, `#fragment`,
 * or relative links resolved against an HTTP(S) `baseUrl`).
 */
export function cleanHtml(
  html: string,
  baseUrl?: string
): { cleanedHtml: string; title: string | null } {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim() || null;

  $(JUNK_SELECTORS).remove();

  $('div, span, p').each((_, el) => {
    const $el = $(el);
    if ($el.text().trim() === '' && $el.children().length === 0) {
      $el.remove();
    }
  });

  // Single-pass allowlist & relative-link normalization for anchors
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const rawHref = ($el.attr('href') ?? '').trim();

    if (!rawHref) {
      $el.removeAttr('href');
      return;
    }

    if (rawHref.startsWith('#')) {
      $el.attr('href', rawHref);
      return;
    }

    try {
      const resolved = new URL(rawHref, baseUrl);
      if (!ALLOWED_LINK_PROTOCOLS.has(resolved.protocol)) {
        $el.removeAttr('href');
        return;
      }
      $el.attr('href', resolved.href);
    } catch {
      $el.removeAttr('href');
    }
  });

  const body = $('body').html() || $.html();

  return {
    cleanedHtml: body,
    title,
  };
}
