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
    expect(result).toBe('Server at [internal-ip] port 8080');
  });

  it('redacts URLs', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Open https://internal.company.com/dashboard');
    expect(result).toBe('Open [internal-system]/dashboard');
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
        'Acme Corp': '[company]',
        'John Smith': '[employee]',
      },
    });
    const result = anon.anonymize('John Smith at Acme Corp');
    expect(result).toBe('[employee] at [company]');
  });

  it('leaves clean text unchanged', () => {
    const anon = new Anonymizer(defaultConfig);
    const text = 'Step 1: Open CRM\nStep 2: Update customer data';
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
    const result = anon.anonymize('Transfer to DE89370400440532013000');
    expect(result).toBe('Transfer to [IBAN]');
  });

  it('redacts IBAN with spaces', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('IBAN: DE89 3704 0044 0532 0130 00');
    expect(result).toBe('IBAN: [IBAN]');
  });

  it('redacts credit card numbers', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Card: 4111-1111-1111-1111');
    expect(result).toBe('Card: [credit-card-number]');
  });

  it('redacts credit card numbers with spaces', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Visa: 4111 1111 1111 1111');
    expect(result).toBe('Visa: [credit-card-number]');
  });

  it('redacts German Steuer-ID', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Steuer-ID: 12345678901');
    expect(result).toBe('Steuer-ID: [tax-id]');
  });

  it('redacts Windows file paths on C: drive', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('File at C:\\Users\\Schmidt\\Documents\\report.xlsx');
    expect(result).toContain('[user]');
    expect(result).not.toContain('Schmidt');
  });

  it('redacts Windows file paths on D: drive', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('File at D:\\Users\\Admin\\Desktop\\secrets.txt');
    expect(result).toContain('[user]');
    expect(result).not.toContain('Admin');
  });

  it('redacts Windows file paths on any drive letter', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Path: E:\\Users\\Employee\\Data\\export.csv');
    expect(result).toContain('[user]');
    expect(result).not.toContain('Employee');
  });

  it('redacts phone numbers (German format)', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Call to +49 170 1234567');
    expect(result).toContain('[phone-number]');
    expect(result).not.toContain('1234567');
  });

  it('redacts phone numbers (local format)', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Office: (089) 1234-5678');
    expect(result).toContain('[phone-number]');
    expect(result).not.toContain('1234');
  });

  it('redacts IPv6 addresses', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('Server: 2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    expect(result).toContain('[internal-ip-v6]');
    expect(result).not.toContain('2001:0db8');
  });

  it('redacts SV-Nummer', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('SV-Nr.: 12 345678 A 123');
    expect(result).toBe('SV-Nr.: [social-security-number]');
  });

  it('redacts Steuer-ID with hyphen variant', () => {
    const anon = new Anonymizer(defaultConfig);
    const result = anon.anonymize('SteuerID: 12345678901');
    expect(result).toBe('Steuer-ID: [tax-id]');
  });

  it('handles multiple PII types in one text', () => {
    const anon = new Anonymizer(defaultConfig);
    const text = 'Contact: admin@firma.de, Server: 10.0.0.5, IBAN: DE89370400440532013000';
    const result = anon.anonymize(text);
    expect(result).not.toContain('admin@firma.de');
    expect(result).not.toContain('10.0.0.5');
    expect(result).not.toContain('DE893704');
    expect(result).toContain('[email@example.com]');
    expect(result).toContain('[internal-ip]');
    expect(result).toContain('[IBAN]');
  });

  it('does not redact version numbers as IPs', () => {
    const anon = new Anonymizer(defaultConfig);
    const text = 'Software version 1.2.3.4 requires update';
    const result = anon.anonymize(text);
    // First octet < 10 → likely version number, should be preserved
    expect(result).toContain('1.2.3.4');
  });

  it('redacts private IPs (10.x, 192.168.x, 172.16.x)', () => {
    const anon = new Anonymizer(defaultConfig);
    expect(anon.anonymize('Server: 10.0.0.1')).toContain('[internal-ip]');
    expect(anon.anonymize('Gateway: 192.168.1.1')).toContain('[internal-ip]');
    expect(anon.anonymize('VPN: 172.16.0.1')).toContain('[internal-ip]');
  });

  it('credit card: does not redact year sequences (Luhn-invalid)', () => {
    // Test with phone redaction disabled to isolate CC behavior
    const anon = new Anonymizer({ ...defaultConfig, redact_phone_numbers: false });
    const text = 'Years 2024 2025 2026 2027 showing growth';
    const result = anon.anonymize(text);
    // Year sequences fail Luhn check and don't start with 3/4/5 → preserved
    expect(result).toContain('2024 2025 2026 2027');
  });

  it('credit card: redacts valid Visa number (Luhn-valid)', () => {
    const anon = new Anonymizer(defaultConfig);
    // 4111 1111 1111 1111 is a standard Visa test number (Luhn-valid)
    const text = 'Card: 4111 1111 1111 1111';
    const result = anon.anonymize(text);
    expect(result).toContain('[credit-card-number]');
  });
});
