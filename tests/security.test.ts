import { describe, expect, it } from 'vitest';
import { __testables } from '../api/index';

describe('web-to-markdown security helpers', () => {
  it('rejects private IPv4 targets', async () => {
    const result = await __testables.validateUrlNotPrivate(new URL('http://127.0.0.1/internal'));
    expect(result.safe).toBe(false);
  });

  it('rejects non-HTML fetched responses', async () => {
    const result = await __testables.validateFetchedResponse(
      'https://example.com/file.json',
      'application/json'
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not HTML');
  });

  it('removes dangerous javascript hrefs during cleaning', () => {
    const { cleanedHtml } = __testables.cleanHtml(
      '<html><body><a href="javascript:alert(1)">bad</a><p>Hello</p></body></html>',
      'https://example.com'
    );
    expect(cleanedHtml).not.toContain('javascript:alert');
  });

  it('converts cleaned HTML into markdown', () => {
    const markdown = __testables.convertToMarkdown('<article><h1>Title</h1><p>Hello world</p></article>');
    expect(markdown).toContain('# Title');
    expect(markdown).toContain('Hello world');
  });
});
