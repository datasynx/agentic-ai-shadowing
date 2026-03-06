// ── Logger ──────────────────────────────────────────────────────────────────
// Abstract logger interface with pluggable backends.
// Default: stderr output in human-readable or NDJSON format.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  module?: string;
  write?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const minLevel = LEVEL_PRIORITY[opts.level ?? (process.env['LOG_LEVEL'] as LogLevel) ?? 'info'];
  const jsonMode = opts.json ?? (process.env['LOG_FORMAT'] === 'json');
  const moduleName = opts.module;
  const write = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));

  function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < minLevel) return;

    if (jsonMode) {
      const entry: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        level,
        msg,
      };
      if (moduleName) entry['module'] = moduleName;
      if (meta && Object.keys(meta).length > 0) Object.assign(entry, meta);
      write(JSON.stringify(entry));
    } else {
      const ts = new Date().toISOString();
      const prefix = moduleName ? `[${moduleName}]` : '';
      const metaStr = meta && Object.keys(meta).length > 0
        ? ' ' + Object.entries(meta).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
        : '';
      write(`${ts} ${level.toUpperCase().padEnd(5)} ${prefix}${prefix ? ' ' : ''}${msg}${metaStr}`);
    }
  }

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };
}

/** No-op logger — discards all log output. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Default application-wide logger instance. */
let _defaultLogger: Logger = createLogger();

export function getLogger(module?: string): Logger {
  if (module) return createLogger({ module });
  return _defaultLogger;
}

export function setDefaultLogger(logger: Logger): void {
  _defaultLogger = logger;
}
