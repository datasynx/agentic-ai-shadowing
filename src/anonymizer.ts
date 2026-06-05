import type { AnonymizationConfig } from './types.js';

export interface RedactionSummary {
  email_count: number;
  ip_count: number;
  url_count: number;
  phone_count: number;
  filepath_count: number;
  iban_count: number;
  credit_card_count: number;
  custom_count: number;
}

function emptyRedactionSummary(): RedactionSummary {
  return { email_count: 0, ip_count: 0, url_count: 0, phone_count: 0, filepath_count: 0, iban_count: 0, credit_card_count: 0, custom_count: 0 };
}

export class Anonymizer {
  constructor(private config: AnonymizationConfig) {}

  /** Anonymize text and return both the result and a redaction summary. */
  anonymizeWithSummary(text: string): { text: string; summary: RedactionSummary } {
    const summary = emptyRedactionSummary();
    let result = text;

    // Custom replacements first (most specific)
    result = this.applyCustomReplacements(result, summary);

    if (this.config.redact_emails) result = this.redactEmails(result, summary);
    if (this.config.redact_ips) result = this.redactIPs(result, summary);
    if (this.config.redact_urls) result = this.redactURLs(result, summary);
    if (this.config.redact_file_paths) result = this.redactFilePaths(result, summary);

    // Specific number patterns BEFORE generic phone pattern (more specific first)
    result = this.redactIBANs(result, summary);
    result = this.redactCreditCards(result, summary);
    result = this.redactGermanIDs(result);

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

  private redactEmails(text: string, summary: RedactionSummary): string {
    let count = 0;
    const result = text.replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      () => { count++; return '[email@example.com]'; },
    );
    summary.email_count += count;
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

  private redactGermanIDs(text: string): string {
    let result = text.replace(
      /\bSteuer-?ID[:\s]+\d{11}\b/gi,
      'Steuer-ID: [tax-id]',
    );
    result = result.replace(
      /\bSV-?(?:Nr|Nummer)[.:\s]+\d{2}\s?\d{6}\s?[A-Z]\s?\d{3}\b/gi,
      'SV-Nr.: [social-security-number]',
    );
    return result;
  }
}
