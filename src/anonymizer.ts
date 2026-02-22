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
    if (this.config.redact_phone_numbers) result = this.redactPhoneNumbers(result);
    if (this.config.redact_file_paths) result = this.redactFilePaths(result);

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
    return text.replace(
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
      '[interne-ip]',
    );
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
    return text.replace(
      /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
      '[Telefonnummer]',
    );
  }

  private redactFilePaths(text: string): string {
    return text.replace(
      /(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"')>]+/g,
      (match) => {
        // Keep the general structure but replace username
        const parts = match.split(/[/\\]/);
        const userIdx = parts.findIndex(p => p === 'Users' || p === 'home');
        if (userIdx >= 0 && userIdx + 1 < parts.length) {
          parts[userIdx + 1] = '[user]';
        }
        return parts.join(match.includes('\\') ? '\\' : '/');
      },
    );
  }
}
