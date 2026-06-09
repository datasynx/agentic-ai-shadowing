import Anthropic from '@anthropic-ai/sdk';
import type { ShadowingConfig } from './types.js';
import { SOPGenerationError } from './errors.js';

/**
 * Build the Anthropic client from config (single construction point for
 * SOPGenerator and SessionAnalyzer).
 *
 * Enterprise deployment knobs (config.sop_generation):
 * - `api_key_env`: name of the env var holding the credential
 *   (default ANTHROPIC_API_KEY) — lets gateways keep their own env naming.
 * - `base_url`: route traffic through an internal gateway or a local
 *   Anthropic-compatible model server instead of api.anthropic.com.
 *   When unset, the SDK default applies — which itself honors the
 *   ANTHROPIC_BASE_URL env var, so we must not override it here.
 */
export function createAnthropicClient(config: ShadowingConfig): Anthropic {
  const apiKeyEnv = config.sop_generation.api_key_env || 'ANTHROPIC_API_KEY';
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new SOPGenerationError(
      `${apiKeyEnv} is not set.\n` +
      'Export your API key:\n\n' +
      `  export ${apiKeyEnv}=sk-ant-...\n`,
      'missing_api_key',
      false,
    );
  }
  return new Anthropic({
    apiKey,
    ...(config.sop_generation.base_url ? { baseURL: config.sop_generation.base_url } : {}),
  });
}
