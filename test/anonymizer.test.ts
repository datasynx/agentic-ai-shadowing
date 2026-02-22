import { describe, it, expect } from 'vitest';
import { Anonymizer } from '../src/anonymizer.js';

const defaultConfig = {
  custom_replacements: {},
  redact_emails: true,
  redact_ips: true,
  redact_urls: true,
  redact_phone_numbers: true,
  redact_file_paths: true,
};

describe('Anonymizer', () => {
  it('redacts email addresses', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Contact john.doe@company.com for help');
    expect(result).toBe('Contact [email@example.com] for help');
  });

  it('redacts IP addresses', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Server at 192.168.1.100 port 8080');
    expect(result).toBe('Server at [interne-ip] port 8080');
  });

  it('redacts URLs', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Open https://internal.company.com/dashboard');
    expect(result).toBe('Open [internes-system]/dashboard');
  });

  it('redacts file paths', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('File at /Users/johndoe/Documents/report.pdf');
    expect(result).toBe('File at /Users/[user]/Documents/report.pdf');
  });

  it('redacts Linux home paths', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Config at /home/developer/.config/app');
    expect(result).toBe('Config at /home/[user]/.config/app');
  });

  it('applies custom replacements', () => {
    const anon = new Anonymizer({
      ...defaultConfig,
      custom_replacements: {
        'Firma GmbH': '[Unternehmen]',
        'Max Mustermann': '[Mitarbeiter]',
      },
    });
    const result = anon.anonymize('Max Mustermann bei Firma GmbH');
    expect(result).toBe('[Mitarbeiter] bei [Unternehmen]');
  });

  it('leaves clean text unchanged', () => {
    const anon = new Anonymizer(defaultConfig);
    const text = 'Schritt 1: CRM öffnen\nSchritt 2: Kundendaten aktualisieren';
    expect(anon.anonymize(text)).toBe(text);
  });

  it('respects disabled redaction rules', () => {
    const anon = new Anonymizer({
      ...defaultConfig,
      redact_emails: false,
      redact_ips: false,
    });
    const result = anon.anonymize('Contact admin@test.com at 10.0.0.1');
    expect(result).toContain('admin@test.com');
    expect(result).toContain('10.0.0.1');
  });

  it('redacts German IBAN', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Überweisung an DE89370400440532013000');
    expect(result).toBe('Überweisung an [IBAN]');
  });

  it('redacts IBAN with spaces', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('IBAN: DE89 3704 0044 0532 0130 00');
    expect(result).toBe('IBAN: [IBAN]');
  });

  it('redacts credit card numbers', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Karte: 4111-1111-1111-1111');
    expect(result).toBe('Karte: [Kreditkartennummer]');
  });

  it('redacts credit card numbers with spaces', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Visa: 4111 1111 1111 1111');
    expect(result).toBe('Visa: [Kreditkartennummer]');
  });

  it('redacts German Steuer-ID', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Steuer-ID: 12345678901');
    expect(result).toBe('Steuer-ID: [Steuer-ID]');
  });

  it('redacts Windows file paths', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Datei unter C:\\Users\\Schmidt\\Documents\\report.xlsx');
    expect(result).toContain('[user]');
    expect(result).not.toContain('Schmidt');
  });

  it('handles multiple PII types in one text', () => {
    const anon = new Anonymizer(defaultConfig);
    const text = 'Kontakt: admin@firma.de, Server: 10.0.0.5, IBAN: DE89370400440532013000';
    const result = anon.anonymize(text);
    expect(result).not.toContain('admin@firma.de');
    expect(result).not.toContain('10.0.0.5');
    expect(result).not.toContain('DE893704');
    expect(result).toContain('[email@example.com]');
    expect(result).toContain('[interne-ip]');
    expect(result).toContain('[IBAN]');
  });
});
