/**
 * AI Service
 * LLM integration for Kora Smart Assistant
 * Supports mode-based prompts via AIConfigRegistry
 */

import 'groq-sdk/shims/node';
import { BaseService } from './BaseService';
import { IPC } from '../../shared/ipc-channels';
import type { ChatMessage, IpcResult } from '../../shared/types';
import type { ConfigService } from './ConfigService';
import { getAIConfigRegistry, type ModeConfig } from './AIConfigRegistry';
import Groq from 'groq-sdk';

// Available Groq models (kept for backward compatibility)
export const GROQ_MODELS = {
  'llama-3.3-70b': 'llama-3.3-70b-versatile',
  'kimi-k2': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'gpt-oss-20b': 'openai/gpt-oss-20b',
  'qwen-qwq-32b': 'qwen-qwq-32b',
  'qwen3-32b': 'qwen/qwen3-32b',
  'llama-3.1-8b': 'llama-3.1-8b-instant',
} as const;

export type GroqModelKey = keyof typeof GROQ_MODELS;

// Default model - can be changed via config
const DEFAULT_MODEL: GroqModelKey = 'llama-3.3-70b';

// Mode-based request options
export interface ModeRequestOptions {
  modeId: string;
  promptKey: string;
  variables?: Record<string, string>;
  userMessage?: string;
  modelOverride?: GroqModelKey;  // Override mode's default model (e.g., fast model for simple conflicts)
}

export class AIService extends BaseService {
  private configService: ConfigService;
  private groq: Groq | null = null;
  private abortController: AbortController | null = null;
  private currentModelKey: GroqModelKey = DEFAULT_MODEL;

  constructor(config: ConfigService) {
    super();
    this.configService = config;
  }

  /**
   * Get the current model key
   */
  getModel(): GroqModelKey {
    return this.currentModelKey;
  }

  /**
   * Set the model to use
   */
  setModel(modelKey: GroqModelKey): void {
    if (!(modelKey in GROQ_MODELS)) {
      throw new Error(`Unknown model: ${modelKey}. Available: ${Object.keys(GROQ_MODELS).join(', ')}`);
    }
    this.currentModelKey = modelKey;
    console.log(`[AIService] Model set to: ${modelKey} (${GROQ_MODELS[modelKey]})`);
  }

  /**
   * Get available models
   */
  getAvailableModels(): Array<{ key: GroqModelKey; id: string; description: string }> {
    return [
      { key: 'llama-3.3-70b', id: GROQ_MODELS['llama-3.3-70b'], description: 'Llama 3.3 70B - General purpose' },
      { key: 'kimi-k2', id: GROQ_MODELS['kimi-k2'], description: 'Kimi K2 - Best for coding/agentic (256K context)' },
      { key: 'gpt-oss-120b', id: GROQ_MODELS['gpt-oss-120b'], description: 'GPT-OSS 120B - OpenAI open-weight, strong reasoning' },
      { key: 'gpt-oss-20b', id: GROQ_MODELS['gpt-oss-20b'], description: 'GPT-OSS 20B - OpenAI open-weight, faster' },
      { key: 'qwen3-32b', id: GROQ_MODELS['qwen3-32b'], description: 'Qwen 3 32B - Good for reasoning/code' },
      { key: 'llama-3.1-8b', id: GROQ_MODELS['llama-3.1-8b'], description: 'Llama 3.1 8B - Fast/lightweight' },
    ];
  }

  private getModelId(): string {
    return GROQ_MODELS[this.currentModelKey];
  }

  private getClient(): Groq {
    if (!this.groq) {
      const apiKey = this.configService.getCredentialValue('groqApiKey');
      if (!apiKey) {
        throw new Error('Groq API key not configured');
      }
      this.groq = new Groq({
        apiKey,
        dangerouslyAllowBrowser: true, // Allow in test/browser environments
      });
    }
    return this.groq;
  }

  /**
   * Send a message and get a complete response
   */
  async sendMessage(messages: ChatMessage[], modelOverride?: GroqModelKey): Promise<IpcResult<string>> {
    return this.wrap(async () => {
      const client = this.getClient();
      const modelId = modelOverride ? GROQ_MODELS[modelOverride] : this.getModelId();

      const groqMessages = messages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

      const response = await client.chat.completions.create({
        model: modelId,
        messages: groqMessages,
        temperature: 0.5,
        max_tokens: 4096, // Increased for code tasks
      });

      return response.choices[0]?.message?.content || '';
    }, 'AI_CHAT_FAILED');
  }

  /**
   * Stream a chat response
   */
  async *streamChat(messages: ChatMessage[], modelOverride?: GroqModelKey): AsyncGenerator<string, void, unknown> {
    const client = this.getClient();
    const modelId = modelOverride ? GROQ_MODELS[modelOverride] : this.getModelId();
    this.abortController = new AbortController();

    const groqMessages = messages.map((m) => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }));

    try {
      const stream = await client.chat.completions.create({
        model: modelId,
        messages: groqMessages,
        temperature: 0.5,
        max_tokens: 4096, // Increased for code tasks
        stream: true,
      });

      for await (const chunk of stream) {
        if (this.abortController?.signal.aborted) {
          break;
        }
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Stop the current stream
   */
  stopStream(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Check if API key is configured
   */
  hasApiKey(): boolean {
    return !!this.configService.getCredentialValue('groqApiKey');
  }

  async healthCheck(): Promise<{ online: boolean; configured: boolean; error?: string }> {
    const configured = this.hasApiKey();
    if (!configured) return { online: false, configured: false, error: 'API key not configured' };
    try {
      const client = this.getClient();
      await client.models.list();
      return { online: true, configured: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { online: false, configured: true, error: msg };
    }
  }

  // ==========================================================================
  // MODE-BASED PROMPTS
  // ==========================================================================

  /**
   * Send a message using a mode's prompt template
   */
  async sendWithMode(options: ModeRequestOptions): Promise<IpcResult<string>> {
    return this.wrap(async () => {
      const registry = getAIConfigRegistry();
      const mode = registry.getMode(options.modeId);

      if (!mode) {
        throw new Error(`Mode not found: ${options.modeId}`);
      }

      // Get model: explicit override > mode settings > default
      const modelKey = options.modelOverride || this.resolveModelKey(mode.settings.model);
      const modelId = GROQ_MODELS[modelKey] || this.getModelId();

      // Build messages from mode prompts
      const messages = this.buildMessagesFromMode(mode, options);

      const client = this.getClient();
      const response = await client.chat.completions.create({
        model: modelId,
        messages,
        temperature: mode.settings.temperature ?? 0.5,
        max_tokens: mode.settings.max_tokens ?? 4096,
      });

      return response.choices[0]?.message?.content || '';
    }, 'AI_MODE_CHAT_FAILED');
  }

  /**
   * Stream a response using a mode's prompt template
   */
  async *streamWithMode(options: ModeRequestOptions): AsyncGenerator<string, void, unknown> {
    const registry = getAIConfigRegistry();
    const mode = registry.getMode(options.modeId);

    if (!mode) {
      throw new Error(`Mode not found: ${options.modeId}`);
    }

    const modelKey = this.resolveModelKey(mode.settings.model);
    const modelId = GROQ_MODELS[modelKey] || this.getModelId();
    const messages = this.buildMessagesFromMode(mode, options);

    const client = this.getClient();
    this.abortController = new AbortController();

    try {
      const stream = await client.chat.completions.create({
        model: modelId,
        messages,
        temperature: mode.settings.temperature ?? 0.5,
        max_tokens: mode.settings.max_tokens ?? 4096,
        stream: true,
      });

      for await (const chunk of stream) {
        if (this.abortController?.signal.aborted) {
          break;
        }
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Get available modes from registry
   */
  getAvailableModes(): Array<{ id: string; name: string; description: string }> {
    const registry = getAIConfigRegistry();
    return registry.getAvailableModes();
  }

  /**
   * Get a specific mode's configuration
   */
  getMode(modeId: string): ModeConfig | null {
    const registry = getAIConfigRegistry();
    return registry.getMode(modeId);
  }

  /**
   * Format a prompt template with variables
   */
  formatPrompt(template: string, variables: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  }

  /**
   * Build chat messages from mode configuration
   */
  private buildMessagesFromMode(
    mode: ModeConfig,
    options: ModeRequestOptions
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    const variables = options.variables || {};

    // Get the prompt configuration
    const prompts = mode.prompts;
    const promptConfig = this.getNestedPrompt(prompts, options.promptKey);

    // Add base system prompt if available
    const baseSystem = this.getNestedPrompt(prompts, 'system.base');
    if (typeof baseSystem === 'string') {
      variables['base_system'] = this.formatPrompt(baseSystem, variables);
    }

    // Build system message
    if (promptConfig && typeof promptConfig === 'object') {
      if ('system' in promptConfig && promptConfig.system) {
        const systemContent = this.formatPrompt(promptConfig.system as string, variables);
        messages.push({ role: 'system', content: systemContent });
      }

      // Build user message from template
      if ('user_template' in promptConfig && promptConfig.user_template && options.userMessage) {
        variables['user_message'] = options.userMessage;
        const userContent = this.formatPrompt(promptConfig.user_template as string, variables);
        messages.push({ role: 'user', content: userContent });
      } else if (options.userMessage) {
        messages.push({ role: 'user', content: options.userMessage });
      }
    } else if (typeof promptConfig === 'string') {
      // Simple string prompt (system only)
      messages.push({ role: 'system', content: this.formatPrompt(promptConfig, variables) });
      if (options.userMessage) {
        messages.push({ role: 'user', content: options.userMessage });
      }
    } else if (options.userMessage) {
      // Fallback - just use user message
      messages.push({ role: 'user', content: options.userMessage });
    }

    return messages;
  }

  /**
   * Get nested prompt value using dot notation
   */
  private getNestedPrompt(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Resolve model key from mode settings
   */
  private resolveModelKey(modelSetting?: string): GroqModelKey {
    if (!modelSetting) {
      return this.currentModelKey;
    }

    // Direct match
    if (modelSetting in GROQ_MODELS) {
      return modelSetting as GroqModelKey;
    }

    // Try to find by model ID
    for (const [key, id] of Object.entries(GROQ_MODELS)) {
      if (id === modelSetting) {
        return key as GroqModelKey;
      }
    }

    return this.currentModelKey;
  }

  /**
   * Cleanup
   */
  async dispose(): Promise<void> {
    this.stopStream();
    this.groq = null;
  }
}
