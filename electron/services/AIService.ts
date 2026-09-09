/**
 * AI Service
 * LLM integration for Kora Smart Assistant
 * Supports mode-based prompts via AIConfigRegistry
 */

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
  // One controller per in-flight stream. A single shared field used to be
  // clobbered when a second stream started — the first stream then checked the
  // wrong controller's signal (so it could never be aborted) and, on finishing,
  // nulled out the second stream's controller (so stopStream() became a no-op).
  // Orphaned, uncancelable streams kept pumping chunks over IPC. Track each
  // independently and abort them all on stopStream().
  private activeStreams: Set<AbortController> = new Set();
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
    const controller = new AbortController();
    this.activeStreams.add(controller);

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
      }, { signal: controller.signal });

      for await (const chunk of stream) {
        if (controller.signal.aborted) {
          break;
        }
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } finally {
      this.activeStreams.delete(controller);
    }
  }

  /**
   * Stop all in-flight streams. The renderer multiplexes every stream onto a
   * single AI_STREAM_CHUNK channel, so "stop" means stop everything.
   */
  stopStream(): void {
    for (const controller of this.activeStreams) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
    this.activeStreams.clear();
  }

  /** True while at least one stream is in flight (diagnostics gauge). */
  debugStreamActive(): boolean {
    return this.activeStreams.size > 0;
  }

  /**
   * Check if API key is configured
   */
  hasApiKey(): boolean {
    return !!this.configService.getCredentialValue('groqApiKey');
  }

  /**
   * Refine a raw, free-form session task description into a high-quality
   * agent brief. One Groq call produces:
   *   - persona: which lens the rewrite was done through (product manager /
   *     senior engineer / senior AI engineer)
   *   - taskTitle: short 5-7 word label suitable for the session header
   *   - refinedTask: structured brief (Goal / Context / Constraints /
   *     Acceptance) with no boilerplate
   *
   * Heuristics-first persona pick happens inside the prompt. Falls back to a
   * sensible default if Groq returns malformed JSON. Doesn't throw on missing
   * key — returns an IpcResult error so the renderer can show a friendly
   * "configure Groq" hint.
   */
  async refineSessionTask(input: {
    rawTask: string;
    agentType: string;
    repoName?: string;
  }): Promise<IpcResult<{ persona: string; taskTitle: string; refinedTask: string }>> {
    return this.wrap(async () => {
      if (!input.rawTask || !input.rawTask.trim()) {
        throw new Error('Task is empty');
      }
      const client = this.getClient();
      // openai/gpt-oss-120b — measurably stronger than llama-3.3-70b at the
      // "expand a vague brief into a specific one" task we're doing here.
      // Still on Groq, still sub-second.
      const modelId = GROQ_MODELS['gpt-oss-120b'];

      const systemPrompt = [
        'You are refining a raw task description so an AI coding agent has a high-quality brief.',
        '',
        'Adopt one of these personas based on what the task is really about:',
        '  - "product_manager": product / design / spec / scoping / UX / requirements',
        '  - "senior_engineer": implementation / refactor / bug / migration / infra / testing',
        '  - "senior_ai_engineer": prompts / model / eval / RAG / agent / LLM ops',
        '',
        'A senior version of each persona, given a vague brief, does this:',
        '  1. Re-states the underlying user need in one line (the WHY, not the what).',
        '  2. Lays out the first 3-5 concrete steps the agent will actually take.',
        '  3. Defines "done" with verifiable criteria — never tautologies like "task is done when it is done".',
        '  4. Calls out implicit assumptions, dependencies, and ambiguities so the human can correct them.',
        '',
        'Output STRICT JSON with this exact shape and nothing else:',
        '{ "persona": "...", "taskTitle": "...", "refinedTask": "..." }',
        '',
        'Rules:',
        '  - taskTitle: 5-7 words, imperative ("Review X and verify Y"), no trailing period.',
        '  - refinedTask: Markdown. Use these section headers, in order:',
        '      **Why** — the underlying need in one sentence.',
        '      **Approach** — 3-5 concrete bullets, each starting with an action verb.',
        '      **Definition of Done** — specific, verifiable, measurable. Reject tautologies.',
        '      **Open questions / assumptions** — anything the user left implicit. State assumptions you\'re making so they can be corrected.',
        '  - Preserve every concrete detail the user gave (libraries, paths, branch names, file names, deadlines).',
        '  - It is OK and EXPECTED to make plausible assumptions to fill gaps — but STATE them in "Open questions / assumptions". A senior PM/engineer always surfaces their assumptions.',
        '  - Avoid: tautology, paraphrasing the brief in different words, generic platitudes ("ensure quality", "make sure to test", "follow best practices").',
        '  - No preamble. No "as a senior X" boilerplate. No apologies. Just the four sections.',
        '',
        'Worked example:',
        'USER: "Make the login faster"',
        'GOOD output (refinedTask):',
        '**Why**',
        'The current login flow is slow enough that users notice — likely hurting activation.',
        '**Approach**',
        '- Measure baseline TTFB and Time-to-Interactive for /login on prod.',
        '- Profile to find the dominant cost (auth call, render, network, CSS).',
        '- Apply the single fix that targets the dominant cost.',
        '- Re-measure and capture before/after traces.',
        '**Definition of Done**',
        '/login Time-to-Interactive on prod is ≥30% faster than baseline, with traces saved as evidence.',
        '**Open questions / assumptions**',
        '- Assuming the bottleneck is server-side until profiling shows otherwise.',
        '- Assuming "faster" means perceived latency, not just TTFB.',
        '- Will not change visual design unless required by the fix.',
      ].join('\n');

      const userPrompt = [
        `Agent runtime: ${input.agentType}`,
        input.repoName ? `Repo: ${input.repoName}` : null,
        '',
        'Raw task:',
        input.rawTask.trim(),
      ].filter(Boolean).join('\n');

      const response = await client.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        // 0.3 produced safe-but-empty rewrites that just paraphrased the
        // user. 0.6 buys enough room to expand without going off-task.
        temperature: 0.6,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      });

      const raw = response.choices[0]?.message?.content || '';
      type RefineShape = { persona?: unknown; taskTitle?: unknown; refinedTask?: unknown };
      let parsed: RefineShape;
      try {
        parsed = JSON.parse(raw) as RefineShape;
      } catch (err) {
        throw new Error(`Refiner returned non-JSON: ${(err as Error).message}`);
      }

      // Validate + defensively fall back rather than throwing — a partial result
      // is more useful than no result.
      const persona =
        parsed.persona === 'product_manager' || parsed.persona === 'senior_engineer' || parsed.persona === 'senior_ai_engineer'
          ? parsed.persona
          : 'senior_engineer';
      const taskTitle = typeof parsed.taskTitle === 'string' && parsed.taskTitle.trim()
        ? parsed.taskTitle.trim().replace(/[.\s]+$/, '')
        : input.rawTask.trim().split(/[.!?\n]/)[0].slice(0, 60);
      const refinedTask = typeof parsed.refinedTask === 'string' && parsed.refinedTask.trim()
        ? parsed.refinedTask.trim()
        : input.rawTask.trim();

      return { persona, taskTitle, refinedTask };
    }, 'AI_REFINE_FAILED');
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
      try {
        const response = await client.chat.completions.create({
          model: modelId,
          messages,
          temperature: mode.settings.temperature ?? 0.5,
          max_tokens: mode.settings.max_tokens ?? 4096,
        });
        return response.choices[0]?.message?.content || '';
      } catch (primaryError) {
        // If primary model fails with 404/model-not-found, fall back to llama-3.3-70b
        const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
        const isModelError = errMsg.includes('404') || errMsg.includes('model_not_found') || errMsg.includes('does not exist');
        if (isModelError && modelId !== GROQ_MODELS['llama-3.3-70b']) {
          console.warn(`[AIService] Model ${modelId} unavailable (${errMsg.slice(0, 80)}), falling back to llama-3.3-70b`);
          const fallbackResponse = await client.chat.completions.create({
            model: GROQ_MODELS['llama-3.3-70b'],
            messages,
            temperature: mode.settings.temperature ?? 0.5,
            max_tokens: mode.settings.max_tokens ?? 4096,
          });
          return fallbackResponse.choices[0]?.message?.content || '';
        }
        throw primaryError;
      }
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
    const controller = new AbortController();
    this.activeStreams.add(controller);

    try {
      const stream = await client.chat.completions.create({
        model: modelId,
        messages,
        temperature: mode.settings.temperature ?? 0.5,
        max_tokens: mode.settings.max_tokens ?? 4096,
        stream: true,
      }, { signal: controller.signal });

      for await (const chunk of stream) {
        if (controller.signal.aborted) {
          break;
        }
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } finally {
      this.activeStreams.delete(controller);
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
