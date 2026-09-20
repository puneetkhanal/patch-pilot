import { z } from 'zod';
import { Config } from '../config/env.js';
import { AiAnalysisProvider } from '../domain/types.js';

export const aiProviderSchema = z.enum(['cursor', 'gemini']);

export function configuredAiProviders(config: Config): AiAnalysisProvider[] {
  const providers: AiAnalysisProvider[] = [];
  if (config.cursorApiKey) providers.push('cursor');
  if (config.geminiApiKey) providers.push('gemini');
  return providers;
}

export function resolveProvider(requested?: AiAnalysisProvider, config?: Config): AiAnalysisProvider {
  if (requested) return requested;
  if (config?.cursorApiKey) return 'cursor';
  if (config?.geminiApiKey) return 'gemini';
  throw Object.assign(new Error('No AI provider configured. Set CURSOR_API_KEY or GEMINI_API_KEY.'), { status: 412 });
}

export function assertProviderConfigured(provider: AiAnalysisProvider, config: Config, flow = 'AI analysis') {
  if (provider === 'cursor' && !config.cursorApiKey) {
    throw Object.assign(new Error(`CURSOR_API_KEY is required for Cursor ${flow}`), { status: 412 });
  }
  if (provider === 'gemini' && !config.geminiApiKey) {
    throw Object.assign(new Error(`GEMINI_API_KEY is required for Gemini ${flow}`), { status: 412 });
  }
}

export function providerModel(config: Config, provider: AiAnalysisProvider) {
  return provider === 'cursor' ? config.cursorModel : config.geminiModel;
}
