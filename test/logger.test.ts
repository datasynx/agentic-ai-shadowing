import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger, noopLogger, getLogger, setDefaultLogger, setLogLevel, getLogLevel } from '../src/logger.js';
import type { Logger } from '../src/logger.js';

describe('Logger', () => {
  it('creates a logger with default settings', () => {
    const logger = createLogger();
    expect(logger).toHaveProperty('debug');
    expect(logger).toHaveProperty('info');
    expect(logger).toHaveProperty('warn');
    expect(logger).toHaveProperty('error');
  });

  it('filters by log level', () => {
    const output: string[] = [];
    const logger = createLogger({
      level: 'warn',
      write: (line) => output.push(line),
    });

    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');

    expect(output).toHaveLength(2);
    expect(output[0]).toContain('WARN');
    expect(output[1]).toContain('ERROR');
  });

  it('includes timestamp in human-readable format', () => {
    const output: string[] = [];
    const logger = createLogger({
      level: 'info',
      write: (line) => output.push(line),
    });

    logger.info('test message');
    expect(output).toHaveLength(1);
    // ISO 8601 timestamp pattern
    expect(output[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('includes module name when provided', () => {
    const output: string[] = [];
    const logger = createLogger({
      level: 'info',
      module: 'test-module',
      write: (line) => output.push(line),
    });

    logger.info('hello');
    expect(output[0]).toContain('[test-module]');
  });

  it('outputs JSON in json mode', () => {
    const output: string[] = [];
    const logger = createLogger({
      level: 'info',
      json: true,
      module: 'mymod',
      write: (line) => output.push(line),
    });

    logger.info('test', { key: 'value' });
    const parsed = JSON.parse(output[0]!);
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test');
    expect(parsed.module).toBe('mymod');
    expect(parsed.key).toBe('value');
  });

  it('includes metadata in human-readable format', () => {
    const output: string[] = [];
    const logger = createLogger({
      level: 'info',
      write: (line) => output.push(line),
    });

    logger.info('action completed', { duration_ms: 150, count: 5 });
    expect(output[0]).toContain('duration_ms=150');
    expect(output[0]).toContain('count=5');
  });

  it('noop logger discards all output', () => {
    // Should not throw
    noopLogger.debug('test');
    noopLogger.info('test');
    noopLogger.warn('test');
    noopLogger.error('test');
  });

  it('getLogger returns module-scoped logger', () => {
    const output: string[] = [];
    const original = getLogger('test-scope');
    expect(original).toBeDefined();
  });

  it('setDefaultLogger changes the default', () => {
    const customLogger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    setDefaultLogger(customLogger);
    const logger = getLogger();
    // The default logger is now customLogger
    expect(logger).toBe(customLogger);

    // Reset to default
    setDefaultLogger(createLogger());
  });

  it('debug level logs everything', () => {
    const output: string[] = [];
    const logger = createLogger({
      level: 'debug',
      write: (line) => output.push(line),
    });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(output).toHaveLength(4);
  });

  it('error level only logs errors', () => {
    const output: string[] = [];
    const logger = createLogger({
      level: 'error',
      write: (line) => output.push(line),
    });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('ERROR');
  });
});

describe('Logger — runtime level (issue #15)', () => {
  afterEach(() => setLogLevel('info'));

  it('setLogLevel affects loggers created without an explicit level', () => {
    const output: string[] = [];
    // No explicit level → follows the global runtime level.
    const logger = createLogger({ write: (line) => output.push(line) });

    setLogLevel('warn');
    logger.info('should be suppressed');
    logger.warn('should appear');

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('WARN');
  });

  it('an explicit level overrides the global runtime level', () => {
    const output: string[] = [];
    const logger = createLogger({ level: 'info', write: (line) => output.push(line) });

    setLogLevel('error');
    logger.info('still appears because level is explicit');

    expect(output).toHaveLength(1);
  });

  it('getLogLevel reflects the current global level', () => {
    setLogLevel('debug');
    expect(getLogLevel()).toBe('debug');
  });
});
