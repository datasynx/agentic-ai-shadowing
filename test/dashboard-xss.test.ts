import { describe, it, expect } from 'vitest';
import { esc, escJs, renderMD, getDashboardClientHelpers } from '../src/dashboard-client.js';
import { getDashboardHTML } from '../src/dashboard-html.js';
import { getDefaultConfig } from '../src/config.js';

describe('esc — HTML text/attribute escaping', () => {
  it('escapes tags', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes BOTH quote characters (attribute-context safety)', () => {
    expect(esc(`"onmouseover="alert(1)`)).toBe('&quot;onmouseover=&quot;alert(1)');
    expect(esc(`'); alert(1); ('`)).toBe('&#39;); alert(1); (&#39;');
  });

  it('escapes ampersands first (no double-escaping)', () => {
    expect(esc('a & b &amp;')).toBe('a &amp; b &amp;amp;');
  });

  it('handles null/undefined', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('escJs — inline event-handler JS-string escaping', () => {
  it('neutralizes single-quote breakout (entity escaping is NOT enough here)', () => {
    // Browsers entity-decode attribute values before the JS parser runs,
    // so the defense must be a JS escape, not an HTML entity.
    const payload = `');alert(1);('`;
    const escaped = escJs(payload);
    expect(escaped).not.toContain(`'`);
    expect(escaped).toContain('\\x27');
  });

  it('neutralizes double quotes, angle brackets and backslashes', () => {
    // Output may contain backslashes (as escape sequences) but never the raw
    // breakout characters themselves.
    expect(escJs(`\\"><script>`)).toBe('\\x5c\\x22\\x3e\\x3cscript\\x3e');
  });

  it('neutralizes newlines', () => {
    expect(escJs('a\nb\rc')).toBe('a\\nb\\rc');
  });
});

const XSS_PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg onload=alert(1)>',
  "'); alert(1); ('",
  'javascript:alert(1)',
  '```\n</code></pre><script>alert(1)</script>\n```',
  '# Title</h1><script>alert(1)</script>',
  '- item<iframe src=evil></iframe>',
];

// Tags renderMD is allowed to emit — always attribute-free.
const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'li', 'code', 'pre', 'strong', 'em', 'blockquote']);

/** Assert that every tag in the HTML is an attribute-free allowlisted tag. */
function expectOnlySafeTags(html: string): void {
  const tags = html.match(/<[^>]*>/g) ?? [];
  for (const tag of tags) {
    // Exactly <name> or </name> — no attributes, no event handlers possible
    const m = /^<\/?([a-z0-9]+)>$/.exec(tag);
    expect(m, `unexpected tag shape: ${tag}`).not.toBeNull();
    expect(ALLOWED_TAGS.has(m![1]!), `tag not allowlisted: ${tag}`).toBe(true);
  }
}

describe('renderMD — escape-first markdown rendering', () => {
  for (const payload of XSS_PAYLOADS) {
    it(`renders payload inert: ${payload.substring(0, 40)}`, () => {
      const html = renderMD(payload);
      // Payload text may survive as escaped TEXT (inert); what must never
      // happen is a real tag outside the allowlist or any tag with attributes.
      expectOnlySafeTags(html);
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<iframe');
    });
  }

  it('renders benign markdown structurally unchanged', () => {
    const html = renderMD('# Title\n## Section\n- one\n- two\n**bold** and *italic* and `code`');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders fenced code blocks with escaped content', () => {
    const html = renderMD('```bash\necho "<b>hi</b>"\n```');
    expect(html).toContain('<pre><code>');
    expect(html).not.toContain('<b>hi</b>');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
  });

  it('handles empty input', () => {
    expect(renderMD('')).toBe('');
    expect(renderMD(null)).toBe('');
  });
});

describe('dashboard HTML integration', () => {
  it('injects the client helpers into the served HTML', () => {
    const html = getDashboardHTML(getDefaultConfig(), 'token');
    expect(html).toContain('var esc = ');
    expect(html).toContain('var escJs = ');
    expect(html).toContain('var renderMD = ');
    // The old DOM-based escaper (quote-unsafe) must be gone
    expect(html).not.toContain("d.textContent = s ?? ''");
  });

  it('serialized helpers are valid standalone JS', () => {
    const src = getDashboardClientHelpers();
    const factory = new Function(`${src}; return { esc: esc, escJs: escJs, renderMD: renderMD };`);
    const helpers = factory() as { esc(s: unknown): string; escJs(s: unknown): string; renderMD(t: unknown): string };
    expect(helpers.esc(`<'"&>`)).toBe('&lt;&#39;&quot;&amp;&gt;');
    expect(helpers.escJs(`'`)).toBe('\\x27');
    expect(helpers.renderMD('# T')).toContain('<h1>T</h1>');
  });

  it('tag interpolation into onclick handlers uses escJs', () => {
    const html = getDashboardHTML(getDefaultConfig(), 'token');
    expect(html).toContain("removeTag(\\'' + escJs(sopId) + '\\',\\'' + escJs(t) + '\\')");
    expect(html).toContain("filterByTag(\\'' + escJs(t.name)");
    expect(html).toContain("toggleTagFilter(\\'' + escJs(t.name)");
  });
});
