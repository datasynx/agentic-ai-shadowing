import { describe, it, expect } from 'vitest';
import { Anonymizer, createCaptureRedactor } from '../src/anonymizer.js';
import { getDefaultConfig } from '../src/config.js';
import type { AnonymizationConfig } from '../src/types.js';

function makeConfig(overrides?: Partial<AnonymizationConfig>): AnonymizationConfig {
  return { ...getDefaultConfig().anonymization, ...overrides };
}

// Fake tokens in the real formats — never real credentials.
const SECRET_CORPUS: Array<{ name: string; text: string; secret: string }> = [
  { name: 'GitHub classic PAT', secret: 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', text: 'export GITHUB_TOKEN=ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' },
  { name: 'GitHub fine-grained PAT', secret: 'github_pat_11AAAAAAA0aaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', text: 'auth with github_pat_11AAAAAAA0aaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb done' },
  { name: 'GitHub OAuth token', secret: 'gho_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', text: 'token gho_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' },
  { name: 'Anthropic API key', secret: 'sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', text: 'export ANTHROPIC_API_KEY=sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' },
  { name: 'OpenAI-style key', secret: 'sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', text: 'OPENAI_API_KEY=sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345' },
  { name: 'AWS access key ID', secret: 'AKIAIOSFODNN7EXAMPLE', text: 'aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE' },
  { name: 'AWS secretsmanager ARN', secret: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:prod/db-AbCdEf', text: 'fetch arn:aws:secretsmanager:eu-central-1:123456789012:secret:prod/db-AbCdEf now' },
  { name: 'Slack bot token', secret: 'xoxb-1234567890-abcdefghijkl', text: 'SLACK_TOKEN=xoxb-1234567890-abcdefghijkl' },
  { name: 'JWT', secret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', text: 'curl -H "X-Auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"' },
];

describe('Anonymizer — secret detection (always-on)', () => {
  const anonymizer = new Anonymizer(makeConfig());

  for (const { name, text, secret } of SECRET_CORPUS) {
    it(`redacts ${name}`, () => {
      const { text: result, summary } = anonymizer.anonymizeWithSummary(text);
      expect(result).not.toContain(secret);
      expect(summary.secret_count).toBeGreaterThanOrEqual(1);
    });
  }

  it('redacts PEM private-key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----';
    const result = anonymizer.anonymize(`key material:\n${pem}\ndone`);
    expect(result).not.toContain('MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn');
    expect(result).toContain('[private-key]');
  });

  it('redacts Bearer header values', () => {
    const result = anonymizer.anonymize('Authorization: Bearer abc123DEF456ghi789JKL012');
    expect(result).toContain('Bearer [api-token]');
    expect(result).not.toContain('abc123DEF456ghi789JKL012');
  });

  it('secret redaction is active even with all configurable redactions off', () => {
    const strict = new Anonymizer(makeConfig({
      redact_emails: false, redact_ips: false, redact_urls: false,
      redact_phone_numbers: false, redact_file_paths: false,
    }));
    const result = strict.anonymize('token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
    expect(result).not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
  });
});

describe('Anonymizer — high-entropy fallback', () => {
  it('redacts unknown high-entropy tokens (mixed case + digits, length >= 28)', () => {
    const token = 'q7Rt2Xv9Lm4Np8Kj3Hw6Zd1Cb5Vf0Gs';
    const anonymizer = new Anonymizer(makeConfig());
    const { text, summary } = anonymizer.anonymizeWithSummary(`API_SECRET=${token}`);
    expect(text).not.toContain(token);
    expect(summary.high_entropy_count).toBe(1);
  });

  it('does NOT redact git commit SHAs (pure hex)', () => {
    const sha = '5c72b46a9f0e3d2c1b8a7f6e5d4c3b2a19087f6e';
    const anonymizer = new Anonymizer(makeConfig());
    expect(anonymizer.anonymize(`git checkout ${sha}`)).toContain(sha);
  });

  it('does NOT redact UUIDs', () => {
    const uuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const anonymizer = new Anonymizer(makeConfig());
    expect(anonymizer.anonymize(`request id ${uuid}`)).toContain(uuid);
  });

  it('does NOT redact ordinary identifiers or sentences', () => {
    const anonymizer = new Anonymizer(makeConfig());
    const text = 'run calculateOverallQualityScore in metrics.ts then npm test';
    expect(anonymizer.anonymize(text)).toBe(text);
  });

  it('can be disabled via redact_high_entropy: false', () => {
    const token = 'q7Rt2Xv9Lm4Np8Kj3Hw6Zd1Cb5Vf0Gs';
    const anonymizer = new Anonymizer(makeConfig({ redact_high_entropy: false }));
    expect(anonymizer.anonymize(`value ${token}`)).toContain(token);
  });
});

describe('Anonymizer — idempotency (redact-on-capture + export double-run)', () => {
  const anonymizer = new Anonymizer(makeConfig());

  const CORPUS = [
    'contact me at jane.doe@example.org or +49 171 1234567',
    'server 10.0.0.5 and https://internal.corp/wiki/page',
    'export ANTHROPIC_API_KEY=sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    'token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 in /home/jane/projects/x',
    '# SOP Title\n\n## Steps\n- step one\n- step two\n\n```bash\ncurl -H "Authorization: Bearer abc123DEF456ghi789JKL012"\n```',
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`anonymize(anonymize(x)) === anonymize(x) — corpus #${i + 1}`, () => {
      const once = anonymizer.anonymize(input);
      const twice = anonymizer.anonymize(once);
      expect(twice).toBe(once);
    });
  }

  it('keeps markdown structure intact', () => {
    const md = '# Title\n\n## Steps\n\n1. Run `npm test`\n2. Check output\n\n> note';
    expect(anonymizer.anonymize(md)).toBe(md);
  });
});

describe('createCaptureRedactor', () => {
  it('returns a redacting function when redact_on_capture is enabled (default)', () => {
    const config = getDefaultConfig();
    const redactor = createCaptureRedactor(config);
    expect(redactor).not.toBeNull();
    expect(redactor!('mail jane@example.com')).not.toContain('jane@example.com');
  });

  it('returns null when redact_on_capture is disabled', () => {
    const config = getDefaultConfig();
    config.anonymization.redact_on_capture = false;
    expect(createCaptureRedactor(config)).toBeNull();
  });
});
