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

describe('Anonymizer — RedactionSummary', () => {
  it('returns zero counts for text without PII', () => {
    const anon = new Anonymizer(fullConfig);
    const { text, summary } = anon.anonymizeWithSummary('Hello world, no PII here.');
    expect(text).toBe('Hello world, no PII here.');
    expect(summary.email_count).toBe(0);
    expect(summary.ip_count).toBe(0);
    expect(summary.url_count).toBe(0);
    expect(summary.phone_count).toBe(0);
    expect(summary.filepath_count).toBe(0);
    expect(summary.iban_count).toBe(0);
    expect(summary.credit_card_count).toBe(0);
    expect(summary.custom_count).toBe(0);
  });

  it('counts email redactions', () => {
    const anon = new Anonymizer(fullConfig);
    const { summary } = anon.anonymizeWithSummary('Contact user@example.com and admin@test.org.');
    expect(summary.email_count).toBe(2);
  });

  it('counts IP redactions', () => {
    const anon = new Anonymizer(fullConfig);
    const { summary } = anon.anonymizeWithSummary('Server at 192.168.1.1 and 10.0.0.5');
    expect(summary.ip_count).toBe(2);
  });

  it('counts URL redactions', () => {
    const anon = new Anonymizer(fullConfig);
    const { summary } = anon.anonymizeWithSummary('Visit https://example.com and http://test.org/path');
    expect(summary.url_count).toBe(2);
  });

  it('counts file path redactions', () => {
    const anon = new Anonymizer(fullConfig);
    const { summary } = anon.anonymizeWithSummary('Files at /home/john/docs and /Users/jane/data');
    expect(summary.filepath_count).toBe(2);
  });

  it('counts custom replacements', () => {
    const anon = new Anonymizer({
      ...fullConfig,
      custom_replacements: { 'ACME Corp': '[company]' },
    });
    const { summary } = anon.anonymizeWithSummary('Welcome to ACME Corp! ACME Corp is great.');
    expect(summary.custom_count).toBe(2);
  });

  it('counts mixed PII types correctly', () => {
    const anon = new Anonymizer(fullConfig);
    const text = 'Email admin@test.com, IP 10.0.0.1, URL https://example.com, file /home/user/docs';
    const { summary } = anon.anonymizeWithSummary(text);
    expect(summary.email_count).toBe(1);
    expect(summary.ip_count).toBe(1);
    expect(summary.url_count).toBe(1);
    expect(summary.filepath_count).toBe(1);
  });

  it('anonymize() still returns just a string', () => {
    const anon = new Anonymizer(fullConfig);
    const result = anon.anonymize('test@example.com');
    expect(typeof result).toBe('string');
    expect(result).toBe('[email@example.com]');
  });
});
