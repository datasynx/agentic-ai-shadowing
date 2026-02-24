import type { AnonymizationConfig } from './types.js';

export class Anonymizer {
  constructor(private config: AnonymizationConfig) {}

  anonymize(text: string): string {
    let result = text;

    // Custom replacements first (most specific)
    result = this.applyCustomReplacements(result);

    if (this.config.redact_emails) result = this.redactEmails(result);
    if (this.config.redact_ips) result = this.redactIPs(result);
    if (this.config.redact_urls) result = this.redactURLs(result);
    if (this.config.redact_file_paths) result = this.redactFilePaths(result);

    // Specific number patterns BEFORE generic phone pattern (more specific first)
    result = this.redactIBANs(result);
    result = this.redactCreditCards(result);
    result = this.redactGermanIDs(result);

    // Phone last — broadest numeric pattern
    if (this.config.redact_phone_numbers) result = this.redactPhoneNumbers(result);

    return result;
  }

  private applyCustomReplacements(text: string): string {
    let result = text;
    for (const [search, replacement] of Object.entries(this.config.custom_replacements)) {
      result = result.replaceAll(search, replacement);
    }
    return result;
  }

  private redactEmails(text: string): string {
    return text.replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      '[email@example.com]',
    );
  }

  private redactIPs(text: string): string {
    // IPv4 — strict: each octet must be 0-255 to avoid matching version numbers
    let result = text.replace(
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
      (match) => {
        // Skip common version-like patterns (e.g., 1.2.3.4 where first octet < 10)
        const octets = match.split('.').map(Number);
        // Private/internal ranges: 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x
        const isPrivate = octets[0] === 10 ||
          (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
          (octets[0] === 192 && octets[1] === 168) ||
          octets[0] === 127 ||
          (octets[0] === 169 && octets[1] === 254);
        // Public IPs with first octet >= 10 are also likely real IPs
        if (isPrivate || octets[0]! >= 10) return '[interne-ip]';
        return match; // Likely a version number (e.g. 1.2.3.4)
      },
    );
    // IPv6 (simplified: 2+ hex groups with colons)
    result = result.replace(
      /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g,
      '[interne-ip-v6]',
    );
    return result;
  }

  private redactURLs(text: string): string {
    return text.replace(
      /https?:\/\/[^\s)>\]]+/g,
      (match) => {
        try {
          const url = new URL(match);
          return `[internes-system]${url.pathname}`;
        } catch {
          return '[internes-system]';
        }
      },
    );
  }

  private redactPhoneNumbers(text: string): string {
    // German format: +49 170 1234567, 0170/1234567, (089) 1234-5678
    return text.replace(
      /(?:\+?\d{1,3}[-.\s/]?)?\(?\d{2,4}\)?[-.\s/]?\d{3,4}[-.\s/]?\d{3,4}/g,
      '[Telefonnummer]',
    );
  }

  private redactFilePaths(text: string): string {
    return text.replace(
      /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"')>]+/g,
      (match) => {
        const parts = match.split(/[/\\]/);
        const userIdx = parts.findIndex(p => p === 'Users' || p === 'home');
        if (userIdx >= 0 && userIdx + 1 < parts.length) {
          parts[userIdx + 1] = '[user]';
        }
        return parts.join(match.includes('\\') ? '\\' : '/');
      },
    );
  }

  // ── Always-on patterns ─────────────────────────────────────────────────────

  private redactIBANs(text: string): string {
    // IBAN: 2 letters + 2 digits + 12-30 alphanumeric (with optional spaces)
    return text.replace(
      /\b[A-Z]{2}\d{2}[\s]?[\dA-Z]{4}[\s]?[\dA-Z]{4}[\s]?[\dA-Z]{4}[\s]?[\dA-Z]{0,4}[\s]?[\dA-Z]{0,4}[\s]?[\dA-Z]{0,4}[\s]?[\dA-Z]{0,2}\b/g,
      '[IBAN]',
    );
  }

  private redactCreditCards(text: string): string {
    // Visa, Mastercard, Amex patterns — validated with Luhn checksum
    return text.replace(
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      (match) => {
        const digits = match.replace(/[\s-]/g, '');
        // Must start with known issuer prefix: 4 (Visa), 5 (MC), 3 (Amex/Diners)
        if (!/^[345]/.test(digits)) return match;
        // Luhn checksum validation
        if (!this.validateLuhn(digits)) return match;
        return '[Kreditkartennummer]';
      },
    );
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
    // German Personalausweis: 9-10 alphanumeric (e.g., T220001293)
    // German Steuer-ID: 11 digits
    let result = text.replace(
      /\bSteuer-?ID[:\s]+\d{11}\b/gi,
      'Steuer-ID: [Steuer-ID]',
    );
    // German Sozialversicherungsnummer: 12 digits
    result = result.replace(
      /\bSV-?(?:Nr|Nummer)[.:\s]+\d{2}\s?\d{6}\s?[A-Z]\s?\d{3}\b/gi,
      'SV-Nr.: [SV-Nummer]',
    );
    return result;
  }
}
