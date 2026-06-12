import { describe, it, expect } from 'vitest';
import { Anonymizer } from '../src/anonymizer.js';
import type { AnonymizationConfig } from '../src/types.js';

const fullConfig: AnonymizationConfig = {
  redact_emails: true,
  redact_ips: true,
  redact_urls: true,
  redact_phone_numbers: true,
  redact_file_paths: true,
  custom_replacements: {},
};

describe('Anonymizer Edge Cases', () => {
  describe('Email Redaction', () => {
    const anon = new Anonymizer(fullConfig);

    it('should redact standard emails', () => {
      expect(anon.anonymize('Contact john@example.com')).toBe('Contact [email@example.com]');
    });

    it('should redact emails with dots and plus signs', () => {
      expect(anon.anonymize('first.last+tag@sub.domain.co.uk')).toContain('[email@example.com]');
    });

    it('should redact multiple emails', () => {
      const result = anon.anonymize('a@b.com and c@d.com');
      expect(result).toBe('[email@example.com] and [email@example.com]');
    });

    it('should not redact invalid emails', () => {
      expect(anon.anonymize('not-an-email')).toBe('not-an-email');
      expect(anon.anonymize('missing@tld')).toBe('missing@tld');
    });
  });

  describe('IP Redaction', () => {
    const anon = new Anonymizer(fullConfig);

    it('should redact private IPs (10.x)', () => {
      expect(anon.anonymize('server 10.0.0.1')).toContain('[internal-ip]');
    });

    it('should redact private IPs (192.168.x)', () => {
      expect(anon.anonymize('router 192.168.1.1')).toContain('[internal-ip]');
    });

    it('should redact loopback (127.0.0.1)', () => {
      expect(anon.anonymize('localhost 127.0.0.1')).toContain('[internal-ip]');
    });

    it('should redact link-local (169.254.x)', () => {
      expect(anon.anonymize('apipa 169.254.0.1')).toContain('[internal-ip]');
    });

    it('should not redact version-number-like patterns', () => {
      const result = anon.anonymize('version 1.2.3.4');
      expect(result).toBe('version 1.2.3.4');
    });

    it('should redact IPv6 addresses', () => {
      expect(anon.anonymize('host fe80:0000:0000:0000:1234:5678:abcd:ef01')).toContain('[internal-ip-v6]');
    });

    it('should redact public IPs', () => {
      expect(anon.anonymize('public 54.239.28.85')).toContain('[internal-ip]');
    });
  });

  describe('URL Redaction', () => {
    const anon = new Anonymizer(fullConfig);

    it('should redact HTTP URLs', () => {
      expect(anon.anonymize('visit http://example.com/page')).toContain('[internal-system]/page');
    });

    it('should redact HTTPS URLs', () => {
      expect(anon.anonymize('visit https://secure.example.com/api/v1')).toContain('[internal-system]/api/v1');
    });

    it('should handle URLs with query params', () => {
      const result = anon.anonymize('https://example.com/search?q=test&page=1');
      expect(result).toContain('[internal-system]');
    });

    it('should handle URLs in markdown', () => {
      const result = anon.anonymize('See [link](https://example.com/path)');
      expect(result).toContain('[internal-system]');
    });

    it('should handle malformed URLs gracefully', () => {
      // http:// alone has no host — regex correctly skips it
      const result = anon.anonymize('http://');
      expect(result).toBe('http://');
    });
  });

  describe('Phone Number Redaction', () => {
    const anon = new Anonymizer(fullConfig);

    it('should redact German phone format', () => {
      expect(anon.anonymize('Call +49 170 1234567')).toContain('[phone-number]');
    });

    it('should redact US phone format', () => {
      expect(anon.anonymize('Call (555) 123-4567')).toContain('[phone-number]');
    });

    it('should redact phone with dashes', () => {
      expect(anon.anonymize('Call 089-1234-5678')).toContain('[phone-number]');
    });
  });

  describe('File Path Redaction', () => {
    const anon = new Anonymizer(fullConfig);

    it('should redact Unix home paths', () => {
      const result = anon.anonymize('file at /home/john/documents/secret.txt');
      expect(result).toContain('/home/[user]/');
      expect(result).not.toContain('john');
    });

    it('should redact macOS paths', () => {
      const result = anon.anonymize('file at /Users/jane/Desktop/file.txt');
      expect(result).toContain('/Users/[user]/');
      expect(result).not.toContain('jane');
    });

    it('should redact Windows paths', () => {
      const result = anon.anonymize('file at C:\\Users\\admin\\Documents\\file.txt');
      expect(result).toContain('[user]');
      expect(result).not.toContain('admin');
    });

    it('should preserve path structure', () => {
      const result = anon.anonymize('/home/developer/project/src/index.ts');
      expect(result).toContain('src/index.ts');
    });
  });

  describe('IBAN Redaction (always active)', () => {
    const anon = new Anonymizer(fullConfig);

    it('should redact German IBANs', () => {
      expect(anon.anonymize('IBAN: DE89370400440532013000')).toContain('[IBAN]');
    });

    it('should redact IBANs with spaces', () => {
      expect(anon.anonymize('IBAN: DE89 3704 0044 0532 0130 00')).toContain('[IBAN]');
    });
  });

  describe('Credit Card Redaction (always active)', () => {
    const anon = new Anonymizer(fullConfig);

    it('should redact valid Visa card numbers', () => {
      // Valid Luhn: 4532015112830366
      expect(anon.anonymize('Card: 4532015112830366')).toContain('[credit-card-number]');
    });

    it('should redact card numbers with dashes', () => {
      expect(anon.anonymize('Card: 4532-0151-1283-0366')).toContain('[credit-card-number]');
    });

    it('should not redact non-card 16-digit numbers', () => {
      // Starting with 9 — not a known issuer
      expect(anon.anonymize('ID: 9999888877776666')).not.toContain('[credit-card-number]');
    });

    it('should not redact invalid Luhn numbers', () => {
      // 4111111111111112 fails Luhn
      expect(anon.anonymize('Card: 4111111111111112')).not.toContain('[credit-card-number]');
    });
  });

  describe('German ID Redaction (always active)', () => {
    const anon = new Anonymizer(fullConfig);

    it('should redact Steuer-ID', () => {
      expect(anon.anonymize('Steuer-ID: 12345678901')).toContain('[tax-id]');
    });

    it('should redact SteuerID without hyphen', () => {
      expect(anon.anonymize('SteuerID: 12345678901')).toContain('[tax-id]');
    });

    it('should redact Sozialversicherungsnummer', () => {
      expect(anon.anonymize('SV-Nr.: 12 345678 A 123')).toContain('[ssn]');
    });
  });

  describe('US SSN Redaction (always active)', () => {
    const anon = new Anonymizer(fullConfig);

    it('redacts dashed SSN', () => {
      expect(anon.anonymize('SSN: 123-45-6789')).toContain('[ssn]');
    });

    it('redacts spaced SSN', () => {
      expect(anon.anonymize('123 45 6789')).toBe('[ssn]');
    });

    it('ignores mixed separators and invalid blocks', () => {
      expect(anon.anonymize('123-45 6789')).toBe('123-45 6789');
      expect(anon.anonymize('900-45-6789')).toBe('900-45-6789');
    });
  });

  describe('Connection-string credentials (always active)', () => {
    const anon = new Anonymizer(fullConfig);

    it('redacts the whole credential URL across schemes', () => {
      expect(anon.anonymize('postgres://admin:S3cretP@ss@db.internal:5432/prod')).toBe('[connection-string]');
      expect(anon.anonymize('https://user:pw@api.corp/v1')).toBe('[connection-string]');
      expect(anon.anonymize('redis://:pw@cache:6379')).toBe('[connection-string]');
    });

    it('leaves credential-free URLs to the URL matcher', () => {
      expect(anon.anonymize('postgres://db.internal:5432/prod')).not.toContain('[connection-string]');
    });
  });

  describe('Custom Replacements', () => {
    it('should apply custom replacements', () => {
      const anon = new Anonymizer({
        ...fullConfig,
        custom_replacements: { 'Acme Corp': '[company]', 'Project X': '[project]' },
      });
      expect(anon.anonymize('At Acme Corp working on Project X'))
        .toBe('At [company] working on [project]');
    });

    it('should apply custom replacements before other patterns', () => {
      const anon = new Anonymizer({
        ...fullConfig,
        custom_replacements: { 'admin@company.com': '[admin-email]' },
      });
      // Custom replacement should match first
      const result = anon.anonymize('contact admin@company.com');
      expect(result).toBe('contact [admin-email]');
    });
  });

  describe('Disabled Features', () => {
    it('should not redact emails when disabled', () => {
      const anon = new Anonymizer({ ...fullConfig, redact_emails: false });
      expect(anon.anonymize('test@example.com')).toBe('test@example.com');
    });

    it('should not redact IPs when disabled', () => {
      const anon = new Anonymizer({ ...fullConfig, redact_ips: false });
      expect(anon.anonymize('10.0.0.1')).toBe('10.0.0.1');
    });

    it('should not redact URLs when disabled', () => {
      const anon = new Anonymizer({ ...fullConfig, redact_urls: false });
      expect(anon.anonymize('https://example.com')).toBe('https://example.com');
    });

    it('should not redact phone numbers when disabled', () => {
      const anon = new Anonymizer({ ...fullConfig, redact_phone_numbers: false });
      expect(anon.anonymize('+49 170 1234567')).toBe('+49 170 1234567');
    });

    it('should not redact file paths when disabled', () => {
      const anon = new Anonymizer({ ...fullConfig, redact_file_paths: false });
      expect(anon.anonymize('/home/user/file.txt')).toBe('/home/user/file.txt');
    });

    it('should still redact IBAN even when all optional features disabled', () => {
      const anon = new Anonymizer({
        redact_emails: false,
        redact_ips: false,
        redact_urls: false,
        redact_phone_numbers: false,
        redact_file_paths: false,
        custom_replacements: {},
      });
      expect(anon.anonymize('IBAN: DE89370400440532013000')).toContain('[IBAN]');
    });
  });

  describe('Text Preservation', () => {
    const anon = new Anonymizer(fullConfig);

    it('should preserve text without PII', () => {
      const text = '# Step 1\nOpen the application and click save.';
      expect(anon.anonymize(text)).toBe(text);
    });

    it('should preserve markdown structure', () => {
      const md = '# Title\n## Section\n- Item 1\n- Item 2\n\n```code```';
      expect(anon.anonymize(md)).toBe(md);
    });

    it('should handle empty string', () => {
      expect(anon.anonymize('')).toBe('');
    });

    it('should handle whitespace-only string', () => {
      expect(anon.anonymize('   \n\t  ')).toBe('   \n\t  ');
    });
  });

  describe('Multiple PII in same text', () => {
    const anon = new Anonymizer(fullConfig);

    it('should redact email and IP in same text', () => {
      const result = anon.anonymize('Server 192.168.1.1 admin user@example.com');
      expect(result).toContain('[internal-ip]');
      expect(result).toContain('[email@example.com]');
    });

    it('should redact file path with email in same text', () => {
      const result = anon.anonymize('Config at /home/admin/config.txt for admin@corp.com');
      expect(result).toContain('[user]');
      expect(result).toContain('[email@example.com]');
    });
  });
});
