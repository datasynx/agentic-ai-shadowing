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
    // IPv4
    let result = text.replace(
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
      '[interne-ip]',
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
      /(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"')>]+/g,
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
    // Visa, Mastercard, Amex patterns (4 groups of 4 digits, with separators)
    return text.replace(
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      '[Kreditkartennummer]',
    );
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
