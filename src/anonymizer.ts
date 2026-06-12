import type { AnonymizationConfig, ShadowingConfig } from './types.js';

export interface RedactionSummary {
  email_count: number;
  ip_count: number;
  url_count: number;
  phone_count: number;
  filepath_count: number;
  iban_count: number;
  credit_card_count: number;
  custom_count: number;
  secret_count: number;
  high_entropy_count: number;
  ssn_count: number;
  credential_count: number;
}

function emptyRedactionSummary(): RedactionSummary {
  return { email_count: 0, ip_count: 0, url_count: 0, phone_count: 0, filepath_count: 0, iban_count: 0, credit_card_count: 0, custom_count: 0, secret_count: 0, high_entropy_count: 0, ssn_count: 0, credential_count: 0 };
}

export class Anonymizer {
  constructor(private config: AnonymizationConfig) {}

  /** Anonymize text and return both the result and a redaction summary. */
  anonymizeWithSummary(text: string): { text: string; summary: RedactionSummary } {
    const summary = emptyRedactionSummary();
    let result = text;

    // Custom replacements first (most specific)
    result = this.applyCustomReplacements(result, summary);

    // Connection-string / basic-auth credentials BEFORE the email/URL matchers,
    // which would otherwise mangle `scheme://user:pass@host` (the email pattern
    // matches the `…@host` fragment and leaves the credentials behind).
    result = this.redactConnectionCredentials(result, summary);

    // Developer secrets are always redacted (never configurable off):
    // known token formats first, then the entropy fallback for unknown formats.
    result = this.redactSecrets(result, summary);
    if (this.config.redact_high_entropy !== false) {
      result = this.redactHighEntropy(result, summary);
    }

    if (this.config.redact_emails) result = this.redactEmails(result, summary);
    if (this.config.redact_ips) result = this.redactIPs(result, summary);
    if (this.config.redact_urls) result = this.redactURLs(result, summary);
    if (this.config.redact_file_paths) result = this.redactFilePaths(result, summary);

    // Specific number patterns BEFORE generic phone pattern (more specific first)
    result = this.redactIBANs(result, summary);
    result = this.redactCreditCards(result, summary);
    result = this.redactSSN(result, summary);
    result = this.redactGermanIDs(result, summary);

    // Phone last — broadest numeric pattern
    if (this.config.redact_phone_numbers) result = this.redactPhoneNumbers(result, summary);

    return { text: result, summary };
  }

  /** Backward-compatible: returns only the anonymized string. */
  anonymize(text: string): string {
    return this.anonymizeWithSummary(text).text;
  }

  private applyCustomReplacements(text: string, summary: RedactionSummary): string {
    let result = text;
    for (const [search, replacement] of Object.entries(this.config.custom_replacements)) {
      const before = result;
      result = result.replaceAll(search, replacement);
      if (result !== before) {
        // Count occurrences that were replaced
        const count = (before.split(search).length - 1);
        summary.custom_count += count;
      }
    }
    return result;
  }

  /**
   * Redact connection-string / basic-auth credentials. Always active. Matches
   * `scheme://[user]:pass@host…` (credentials present) and replaces the WHOLE
   * URL with a single token, so no residual `…@host` re-triggers the email
   * matcher (idempotency) and the internal host/port are not leaked either.
   * The password may itself contain `@`; the greedy match extends to the last
   * `@` before the host.
   */
  private redactConnectionCredentials(text: string, summary: RedactionSummary): string {
    let count = 0;
    const result = text.replace(
      /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@]*:[^\s]*@[^\s]+/g,
      () => { count++; return '[connection-string]'; },
    );
    summary.credential_count += count;
    return result;
  }

  private redactEmails(text: string, summary: RedactionSummary): string {
    let count = 0;
    // The replacement placeholder itself contains an email-shaped string, so
    // skip exactly our own bracketed placeholder for idempotency (required:
    // redact-on-capture and export both run this pipeline over the same text).
    // A lookaround-based skip is NOT safe here — backtracking can shrink the
    // TLD match to dodge the lookahead and corrupt the placeholder.
    const result = text.replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      (match, offset: number, whole: string) => {
        const before = whole[offset - 1] ?? '';
        const after = whole[offset + match.length] ?? '';
        if (match === 'email@example.com' && before === '[' && after === ']') return match;
        count++;
        return '[email@example.com]';
      },
    );
    summary.email_count += count;
    return result;
  }

  // ── Secret detection (always-on) ───────────────────────────────────────────

  /**
   * Redact known developer-secret formats. Always active regardless of config:
   * a tool that records shell commands must never persist a pasted credential.
   */
  private redactSecrets(text: string, summary: RedactionSummary): string {
    let count = 0;
    let result = text;
    const apply = (re: RegExp, replacement: string): void => {
      result = result.replace(re, () => { count++; return replacement; });
    };

    // PEM private-key blocks (RSA, EC, OPENSSH, PKCS#8, ...)
    apply(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[private-key]');
    // GitHub tokens: classic (ghp_/gho_/ghu_/ghs_/ghr_) and fine-grained
    apply(/\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, '[github-token]');
    apply(/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, '[github-token]');
    // Anthropic keys before the generic sk- pattern (more specific first)
    apply(/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, '[anthropic-api-key]');
    apply(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[api-key]');
    // AWS access key IDs and Secrets Manager ARNs
    apply(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[aws-access-key-id]');
    apply(/\barn:aws:secretsmanager:[^\s"']+/g, '[aws-secret-arn]');
    // Slack tokens
    apply(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[slack-token]');
    // JWTs (three base64url segments starting with the {"alg" header)
    apply(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[jwt]');
    // Generic Authorization bearer values (after the specific formats above)
    apply(/\bBearer\s+(?!\[)[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [api-token]');

    summary.secret_count += count;
    return result;
  }

  /**
   * Entropy fallback for unknown token formats (config: redact_high_entropy,
   * default true). Deliberately conservative to avoid false positives:
   * requires length >= 28, mixed character classes, and high Shannon entropy.
   * Pure hex (git SHAs), pure digits, and UUIDs are explicitly skipped.
   */
  private redactHighEntropy(text: string, summary: RedactionSummary): string {
    let count = 0;
    const result = text.replace(/[A-Za-z0-9+/=_-]{28,}/g, (word) => {
      if (/^[0-9a-f-]+$/i.test(word)) return word; // hex digests, UUIDs
      if (/^[\d-]+$/.test(word)) return word;       // long numbers
      if (!/[A-Z]/.test(word) || !/[a-z]/.test(word) || !/\d/.test(word)) return word;
      if (shannonEntropy(word) < 3.8) return word;
      count++;
      return '[high-entropy-string]';
    });
    summary.high_entropy_count += count;
    return result;
  }

  private redactIPs(text: string, summary: RedactionSummary): string {
    let count = 0;
    // IPv4 — strict: each octet must be 0-255 to avoid matching version numbers
    let result = text.replace(
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
      (match) => {
        const octets = match.split('.').map(Number);
        const isPrivate = octets[0] === 10 ||
          (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
          (octets[0] === 192 && octets[1] === 168) ||
          octets[0] === 127 ||
          (octets[0] === 169 && octets[1] === 254);
        if (isPrivate || octets[0]! >= 10) { count++; return '[internal-ip]'; }
        return match;
      },
    );
    // IPv6 (simplified: 2+ hex groups with colons)
    result = result.replace(
      /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g,
      () => { count++; return '[internal-ip-v6]'; },
    );
    summary.ip_count += count;
    return result;
  }

  private redactURLs(text: string, summary: RedactionSummary): string {
    let count = 0;
    const result = text.replace(
      /https?:\/\/[^\s)>\]]+/g,
      (match) => {
        count++;
        try {
          const url = new URL(match);
          return `[internal-system]${url.pathname}`;
        } catch {
          return '[internal-system]';
        }
      },
    );
    summary.url_count += count;
    return result;
  }

  private redactPhoneNumbers(text: string, summary: RedactionSummary): string {
    let count = 0;
    const result = text.replace(
      /(?:\+?\d{1,3}[-.\s/]?)?\(?\d{2,4}\)?[-.\s/]?\d{3,4}[-.\s/]?\d{3,4}/g,
      () => { count++; return '[phone-number]'; },
    );
    summary.phone_count += count;
    return result;
  }

  private redactFilePaths(text: string, summary: RedactionSummary): string {
    let count = 0;
    const result = text.replace(
      /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"')>]+/g,
      (match) => {
        count++;
        const parts = match.split(/[/\\]/);
        const userIdx = parts.findIndex(p => p === 'Users' || p === 'home');
        if (userIdx >= 0 && userIdx + 1 < parts.length) {
          parts[userIdx + 1] = '[user]';
        }
        return parts.join(match.includes('\\') ? '\\' : '/');
      },
    );
    summary.filepath_count += count;
    return result;
  }

  // ── Always-on patterns ─────────────────────────────────────────────────────

  private redactIBANs(text: string, summary: RedactionSummary): string {
    let count = 0;
    const result = text.replace(
      /\b[A-Z]{2}\d{2}[\s]?[\dA-Z]{4}[\s]?[\dA-Z]{4}[\s]?[\dA-Z]{4}[\s]?[\dA-Z]{0,4}[\s]?[\dA-Z]{0,4}[\s]?[\dA-Z]{0,4}[\s]?[\dA-Z]{0,2}\b/g,
      () => { count++; return '[IBAN]'; },
    );
    summary.iban_count += count;
    return result;
  }

  private redactCreditCards(text: string, summary: RedactionSummary): string {
    let count = 0;
    const result = text.replace(
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      (match) => {
        const digits = match.replace(/[\s-]/g, '');
        if (!/^[345]/.test(digits)) return match;
        if (!this.validateLuhn(digits)) return match;
        count++;
        return '[credit-card-number]';
      },
    );
    summary.credit_card_count += count;
    return result;
  }

  private validateLuhn(digits: string): boolean {
    let sum = 0;
    let alternate = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i]!, 10);
      if (alternate) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alternate = !alternate;
    }
    return sum % 10 === 0;
  }

  /**
   * US Social Security Numbers: `AAA-GG-SSSS` / `AAA GG SSSS` (consistent
   * separator). Always active. Guards exclude structurally invalid blocks —
   * area 000/666/900-999, group 00, serial 0000 — to limit false positives.
   * Runs before the broad phone matcher so the SSN isn't swallowed as a phone.
   */
  private redactSSN(text: string, summary: RedactionSummary): string {
    let count = 0;
    const result = text.replace(
      /\b(\d{3})([- ])(\d{2})\2(\d{4})\b/g,
      (m, a: string, _sep: string, g: string, ser: string) => {
        const area = Number(a), group = Number(g), serial = Number(ser);
        if (area === 0 || area === 666 || area >= 900) return m;
        if (group === 0 || serial === 0) return m;
        count++;
        return '[ssn]';
      },
    );
    summary.ssn_count += count;
    return result;
  }

  private redactGermanIDs(text: string, summary: RedactionSummary): string {
    let result = text.replace(
      /\bSteuer-?ID[:\s]+\d{11}\b/gi,
      'Steuer-ID: [tax-id]',
    );
    result = result.replace(
      /\bSV-?(?:Nr|Nummer)[.:\s]+\d{2}\s?\d{6}\s?[A-Z]\s?\d{3}\b/gi,
      () => { summary.ssn_count++; return 'SV-Nr.: [ssn]'; },
    );
    return result;
  }
}

/** Shannon entropy in bits per character. Random base64 is ~6, English text ~4. */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Build the redact-on-capture function used by the observation layer
 * (Observer, Claude Code hook handler, MCP log tools, task notes).
 * Returns null when `anonymization.redact_on_capture` is disabled —
 * callers then persist raw data and rely on export-time anonymization only.
 */
export function createCaptureRedactor(config: ShadowingConfig): ((text: string) => string) | null {
  if (config.anonymization.redact_on_capture === false) return null;
  const anonymizer = new Anonymizer(config.anonymization);
  return (text: string) => anonymizer.anonymize(text);
}
