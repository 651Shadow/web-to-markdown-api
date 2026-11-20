import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import { cleanHtml } from '../src/pipeline/cleanHtml';
import { convertToMarkdown } from '../src/pipeline/toMarkdown';
import {
  isPrivateIP,
  resolveSafeTarget,
  validateUrl,
  type DnsLookupFn,
} from '../src/security/ssrf';

const offlinePublicDns: DnsLookupFn = async (hostname) => {
  if (hostname === 'example.com') {
    return [{ address: '93.184.216.34', family: 4 }];
  }
  if (hostname === 'dual-rebinding.example.com') {
    return [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.42', family: 4 },
    ];
  }
  if (hostname === 'internal.example.com') {
    return [{ address: '192.168.1.50', family: 4 }];
  }
  throw new Error('ENOTFOUND');
};

describe('web-to-markdown security & pipeline unit tests', () => {
  it('blocks private, loopback, link-local, CGNAT, multicast, and reserved IPv4 addresses', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('10.255.0.1')).toBe(true);
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('172.31.255.254')).toBe(true);
    expect(isPrivateIP('192.168.1.1')).toBe(true);
    expect(isPrivateIP('169.254.169.254')).toBe(true);
    expect(isPrivateIP('100.64.0.1')).toBe(true);
    expect(isPrivateIP('0.0.0.0')).toBe(true);
    expect(isPrivateIP('224.0.0.1')).toBe(true);
    expect(isPrivateIP('240.0.0.1')).toBe(true);
    expect(isPrivateIP('255.255.255.255')).toBe(true);

    expect(isPrivateIP('93.184.216.34')).toBe(false);
    expect(isPrivateIP('172.32.0.1')).toBe(false);
  });

  it('blocks IPv6 loopback, link-local, unique-local, transition, and hex IPv4-mapped IPv6 bypasses', async () => {
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('::')).toBe(true);
    expect(isPrivateIP('::127.0.0.1')).toBe(true);
    expect(isPrivateIP('64:ff9b::127.0.0.1')).toBe(true);
    expect(isPrivateIP('2002:7f00:1::')).toBe(true);
    expect(isPrivateIP('2001:db8::1')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
    expect(isPrivateIP('febf::1')).toBe(true);
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fd12:3456:789a::1')).toBe(true);
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true);

    // Public IPv6 and short hextet that is NOT in fc00::/7
    expect(isPrivateIP('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    expect(isPrivateIP('fc::1')).toBe(false);
    expect(isPrivateIP('::ffff:93.184.216.34')).toBe(false);

    // URL-normalized hex IPv4-mapped IPv6 literals
    await expect(
      resolveSafeTarget(new URL('http://[::ffff:127.0.0.1]/admin'), offlinePublicDns)
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'SSRF_BLOCKED',
    });

    await expect(
      resolveSafeTarget(
        new URL('http://[::ffff:169.254.169.254]/latest/meta-data/'),
        offlinePublicDns
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'SSRF_BLOCKED',
    });
  });

  it('resolves public hostnames offline and pins the validated IP without leaking private IPs', async () => {
    const target = await resolveSafeTarget(
      new URL('https://example.com/article'),
      offlinePublicDns
    );
    expect(target.address).toBe('93.184.216.34');
    expect(target.family).toBe(4);

    await expect(
      resolveSafeTarget(new URL('http://localhost./secret'), offlinePublicDns)
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'SSRF_BLOCKED',
    });

    try {
      await resolveSafeTarget(
        new URL('https://dual-rebinding.example.com/page'),
        offlinePublicDns
      );
      expect.fail('Expected resolveSafeTarget to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.statusCode).toBe(403);
      expect(apiErr.code).toBe('SSRF_BLOCKED');
      // Must never echo the resolved internal IP address
      expect(apiErr.message).not.toContain('10.0.0.42');
    }
  });

  it('validates HTTP/HTTPS URLs only', () => {
    expect(validateUrl('https://example.com/path')?.href).toBe(
      'https://example.com/path'
    );
    expect(validateUrl('ftp://example.com/file')).toBeNull();
    expect(validateUrl('javascript:alert(1)')).toBeNull();
    expect(validateUrl('not a url')).toBeNull();
  });

  it('sanitizes dangerous and control-char-obfuscated hrefs via a single-pass allowlist', () => {
    const { cleanedHtml } = cleanHtml(
      `<html><body>
        <a id="js" href="javascript:alert(1)">bad1</a>
        <a id="tab" href="java\tscript:alert(1)">bad2</a>
        <a id="nl" href="java\nscript:alert(1)">bad3</a>
        <a id="data" href="data:text/html,<script>alert(1)</script>">bad4</a>
        <a id="rel" href="/docs/start">Docs</a>
        <a id="mail" href="mailto:team@example.com">Email</a>
        <a id="frag" href="#overview">Overview</a>
      </body></html>`,
      'https://example.com/guide/index.html'
    );

    expect(cleanedHtml).not.toContain('javascript:');
    expect(cleanedHtml).not.toContain('data:text/html');
    expect(cleanedHtml).toContain('href="https://example.com/docs/start"');
    expect(cleanedHtml).toContain('href="mailto:team@example.com"');
    expect(cleanedHtml).toContain('href="#overview"');
  });

  it('preserves semantic <article><header><h1> titles and .alert/.notice callouts while stripping body > header', () => {
    const { cleanedHtml } = cleanHtml(
      `<html><body>
        <header><nav>Top Site Nav</nav></header>
        <article>
          <header><h1>Deep Dive Title</h1></header>
          <div class="alert">Critical security warning</div>
          <div class="notice">Migration note</div>
          <p>Main article paragraph.</p>
        </article>
      </body></html>`
    );

    const markdown = convertToMarkdown(cleanedHtml);
    expect(markdown).not.toContain('Top Site Nav');
    expect(markdown).toContain('# Deep Dive Title');
    expect(markdown).toContain('Critical security warning');
    expect(markdown).toContain('Migration note');
    expect(markdown).toContain('Main article paragraph.');
  });
});
