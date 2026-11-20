import TurndownService from 'turndown';
import { strikethrough, tables } from 'turndown-plugin-gfm';
import { ApiError } from '../errors';
import type { ResolvedDocument } from '../http/parseInput';
import { cleanHtml } from './cleanHtml';

export interface ApiResponse {
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

function createTurndownService(): TurndownService {
  const service = new TurndownService({
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

  service.use([tables, strikethrough]);

  service.addRule('removeImages', {
    filter: 'img',
    replacement: () => '',
  });

  service.addRule('cleanLinks', {
    filter: (node) =>
      node.nodeName === 'A' &&
      (!node.textContent || node.textContent.trim() === ''),
    replacement: () => '',
  });

  return service;
}

// Module-level singleton Turndown instance
const turndownService = createTurndownService();

/**
 * Converts cleaned HTML to normalized Markdown using the singleton Turndown instance.
 */
export function convertToMarkdown(html: string): string {
  const markdown = turndownService.turndown(html);

  return markdown
    .replace(/^(\s*)-\s+/gm, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Runs the unified HTML cleaning + Markdown conversion + metrics pipeline
 * for both direct HTML and fetched URL documents.
 */
export function convertDocument(document: ResolvedDocument): ApiResponse {
  try {
    const { cleanedHtml, title } = cleanHtml(
      document.html,
      document.url ?? undefined
    );
    const markdown = convertToMarkdown(cleanedHtml);
    const cleanLength = Buffer.byteLength(markdown, 'utf8');
    const tokenSavingsPercentage =
      document.originalLength > 0
        ? Math.round(
            ((document.originalLength - cleanLength) / document.originalLength) *
              100
          )
        : 0;

    return {
      url: document.url,
      source: document.source,
      markdown,
      meta: {
        title,
        original_length: document.originalLength,
        clean_length: cleanLength,
        token_savings_percentage: Math.max(0, tokenSavingsPercentage),
      },
    };
  } catch {
    throw new ApiError(
      500,
      'PROCESSING_ERROR',
      'Failed to process the HTML content'
    );
  }
}
