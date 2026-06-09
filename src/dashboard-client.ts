/**
 * Client-side helper functions for the embedded dashboard.
 *
 * These functions are defined here (instead of inline in dashboard-html.ts)
 * for two reasons:
 *  1. They are the dashboard's XSS defense layer and must be unit-testable
 *     from Node (see test/dashboard-xss.test.ts).
 *  2. A single source of truth: the same code that runs in tests is
 *     serialized via Function.prototype.toString() and injected into the
 *     served HTML.
 *
 * Security contract:
 *  - `esc`     escapes for HTML text and double-quoted attribute contexts
 *              (including both quote characters).
 *  - `escJs`   escapes for single-quoted JS string literals inside inline
 *              event handlers. Entity-escaping is NOT sufficient there:
 *              attributes are entity-decoded before the JS parser runs, so
 *              `&#39;` would still break out. Hex escapes (\x27) survive.
 *  - `renderMD` is escape-first: the complete input is entity-escaped before
 *              any structural markdown regex runs, so user/LLM content can
 *              never introduce tags or attributes.
 *
 * Each function must be self-contained (no references to other module-level
 * bindings) because it is serialized individually into the browser scope.
 */

/** Escape a value for HTML text content or double-quoted attribute values. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a value for a single-quoted JS string inside an inline event handler. */
export function escJs(s: unknown): string {
  return String(s ?? '')
    .replace(/\\/g, '\\x5c')
    .replace(/'/g, '\\x27')
    .replace(/"/g, '\\x22')
    .replace(/</g, '\\x3c')
    .replace(/>/g, '\\x3e')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/** Escape-first minimal markdown renderer (headings, lists, code, bold/italic). */
export function renderMD(text: unknown): string {
  if (!text) return '';
  // Self-contained escape (same rules as esc) — input is fully entity-escaped
  // BEFORE any structural replacement, so content cannot inject markup.
  let html = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_m, _lang, code) {
    return '<pre><code>' + code + '</code></pre>';
  });
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold & italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Blockquotes (input is escaped, so '>' is '&gt;')
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Paragraphs
  html = html.replace(/^(?!<[hupbo]|<li|<code|<pre)(\S.+)$/gm, '<p>$1</p>');
  // Clean up extra newlines
  html = html.replace(/\n{2,}/g, '\n');
  return html;
}

/**
 * Serialize the helpers as browser-executable script source.
 * Bound via `var name = <fn>` so bundler-renamed identifiers cannot break
 * the call sites in the dashboard template.
 */
export function getDashboardClientHelpers(): string {
  return [
    `var esc = ${esc.toString()};`,
    `var escJs = ${escJs.toString()};`,
    `var renderMD = ${renderMD.toString()};`,
  ].join('\n');
}
