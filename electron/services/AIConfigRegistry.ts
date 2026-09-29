/**
 * AI Config Registry
 * Loads AI model and mode configurations from YAML with external config override support
 *
 * Config sources (priority order):
 * 1. External config (EXTERNAL_AI_CONFIG_PATH env var)
 * 2. Submodule config (ai-backend/src/config/)
 * 3. Built-in defaults (electron/config/)
 *
 * Follows the External Config Architecture pattern from Core_Ai_Backend
 */

import { BaseService } from './BaseService';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { IpcResult } from '../../shared/types';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface ModelSettings {
  temperature: number;
  top_p: number;
  reasoning_format?: string;
}

export interface ModelPricing {
  input: number;
  output: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  description: string;
  provider: string;
  context_window: number;
  max_tokens: number;
  settings: ModelSettings;
  pricing: ModelPricing;
  use_cases: string[];
}

export interface TaskDefault {
  primary: string;
  fallback: string;
}

export interface ProviderConfig {
  name: string;
  base_url: string;
  env_key: string;
  credential_key: string;
  rate_limits: {
    requests_per_minute: number;
    tokens_per_minute: number;
  };
}

export interface AIModelsConfig {
  version: string;
  default_model: string;
  models: Record<string, ModelConfig>;
  task_defaults: Record<string, TaskDefault>;
  providers: Record<string, ProviderConfig>;
}

export interface ModePersona {
  name: string;
  tone: string;
  style: string;
  traits?: string[];
}

export interface ModePrompt {
  system?: string;
  user_template?: string;
}

export interface ModeConfig {
  mode: {
    id: string;
    name: string;
    description: string;
    version: string;
    app?: string;
  };
  settings: {
    temperature: number;
    max_tokens: number;
    model?: string;
    [key: string]: unknown;
  };
  persona?: ModePersona;
  opening?: {
    message: string;
  };
  prompts: Record<string, ModePrompt | Record<string, ModePrompt>>;
  flow?: {
    type: string;
    output_format?: string;
    sections?: string[];
    features?: string[];
  };
}

interface ConfigSource {
  path: string;
  type: 'external' | 'submodule' | 'default';
  exists: boolean;
  loaded: boolean;
  itemCount: number;
}

// ============================================================================
// AI CONFIG REGISTRY
// ============================================================================

export class AIConfigRegistry extends BaseService {
  private modelsConfig: AIModelsConfig | null = null;
  private modes: Map<string, ModeConfig> = new Map();
  private modeSources: Map<string, string> = new Map(); // mode_id -> source_type
  private configSources: ConfigSource[] = [];

  constructor() {
    super();
    this.loadAllConfigs();
  }

  // ==========================================================================
  // CONFIG PATH RESOLUTION
  // ==========================================================================

  /**
   * Get model config paths in priority order
   */
  private getModelConfigPaths(): Array<{ path: string; type: ConfigSource['type'] }> {
    const paths: Array<{ path: string; type: ConfigSource['type'] }> = [];

    // Priority 1: External config from environment
    const externalPath = process.env.EXTERNAL_AI_CONFIG_PATH;
    if (externalPath) {
      paths.push({ path: path.join(externalPath, 'ai-models.yaml'), type: 'external' });
    }

    // Priority 2: Built-in default
    const defaultPath = path.join(__dirname, '..', 'config', 'ai-models.yaml');
    paths.push({ path: defaultPath, type: 'default' });

    return paths;
  }

  /**
   * Get mode config directories in priority order (higher priority first)
   */
  private getModeConfigPaths(): Array<{ path: string; type: ConfigSource['type'] }> {
    const paths: Array<{ path: string; type: ConfigSource['type'] }> = [];

    // Priority 1: External config from environment
    const externalPath = process.env.EXTERNAL_AI_CONFIG_PATH;
    if (externalPath) {
      paths.push({ path: path.join(externalPath, 'modes'), type: 'external' });
    }

    // Priority 2: App-specific modes (DevOps Agent)
    const appModesPath = path.join(__dirname, '..', 'config', 'modes');
    paths.push({ path: appModesPath, type: 'default' });

    // Priority 3: Submodule modes (Core_Ai_Backend - lower priority, general modes)
    const submodulePath = path.join(__dirname, '..', '..', 'ai-backend', 'src', 'config', 'modes');
    paths.push({ path: submodulePath, type: 'submodule' });

    return paths;
  }

  // ==========================================================================
  // CONFIG LOADING
  // ==========================================================================

  /**
   * Load all configurations
   */
  private loadAllConfigs(): void {
    this.loadModelsConfig();
    this.loadModes();
    console.log(`[AIConfigRegistry] Loaded ${Object.keys(this.modelsConfig?.models || {}).length} models, ${this.modes.size} modes`);
  }

  /**
   * Load AI models configuration from YAML
   */
  private loadModelsConfig(): void {
    const configPaths = this.getModelConfigPaths();

    for (const { path: configPath, type } of configPaths) {
      if (existsSync(configPath) && !this.modelsConfig) {
        try {
          const content = readFileSync(configPath, 'utf-8');
          this.modelsConfig = yaml.load(content) as AIModelsConfig;
          console.log(`[AIConfigRegistry] Loaded models config from ${type}: ${configPath}`);
          break;
        } catch (error) {
          console.error(`[AIConfigRegistry] Failed to load models config from ${configPath}:`, error);
        }
      }
    }

    // Fallback to defaults
    if (!this.modelsConfig) {
      this.modelsConfig = this.getDefaultModelsConfig();
    }
  }

  /**
   * Load mode configurations from all sources
   * Later sources override earlier ones (so app-specific overrides submodule)
   */
  private loadModes(): void {
    this.modes.clear();
    this.modeSources.clear();
    this.configSources = [];

    const modePaths = this.getModeConfigPaths();

    // Load in reverse order so higher priority overwrites lower
    for (const { path: modesDir, type } of [...modePaths].reverse()) {
      const source: ConfigSource = {
        path: modesDir,
        type,
        exists: existsSync(modesDir),
        loaded: false,
        itemCount: 0,
      };

      if (source.exists) {
        try {
          const files = readdirSync(modesDir).filter(
            (f) => f.endsWith('.yaml') && !f.startsWith('_')
          );

          for (const file of files) {
            const filePath = path.join(modesDir, file);
            try {
              const content = readFileSync(filePath, 'utf-8');
              const modeConfig = yaml.load(content) as ModeConfig;

              if (modeConfig?.mode?.id) {
                this.modes.set(modeConfig.mode.id, modeConfig);
                this.modeSources.set(modeConfig.mode.id, type);
                source.itemCount++;
              }
            } catch (err) {
              console.error(`[AIConfigRegistry] Failed to load mode from ${filePath}:`, err);
            }
          }

          source.loaded = true;
          console.log(`[AIConfigRegistry] Loaded ${source.itemCount} modes from ${type}: ${modesDir}`);
        } catch (err) {
          console.error(`[AIConfigRegistry] Failed to read modes directory ${modesDir}:`, err);
        }
      }

      this.configSources.push(source);
    }
  }

  /**
   * Get default models config as fallback
   */
  private getDefaultModelsConfig(): AIModelsConfig {
    return {
      version: '1.0.0',
      default_model: 'gpt-oss-120b',
      models: {
        'gpt-oss-120b': {
          id: 'openai/gpt-oss-120b',
          name: 'GPT-OSS 120B',
          description: 'Strong reasoning and code',
          provider: 'groq',
          context_window: 131072,
          max_tokens: 8192,
          settings: { temperature: 0.5, top_p: 1.0 },
          pricing: { input: 0.15, output: 0.6 },
          use_cases: ['general', 'coding', 'reasoning'],
        },
        'gpt-oss-20b': {
          id: 'openai/gpt-oss-20b',
          name: 'GPT-OSS 20B',
          description: 'Fast and lightweight',
          provider: 'groq',
          context_window: 131072,
          max_tokens: 4096,
          settings: { temperature: 0.5, top_p: 1.0 },
          pricing: { input: 0.075, output: 0.3 },
          use_cases: ['simple_tasks', 'fast_inference'],
        },
      },
      task_defaults: {
        coding: { primary: 'gpt-oss-120b', fallback: 'gpt-oss-20b' },
        code_review: { primary: 'gpt-oss-120b', fallback: 'gpt-oss-20b' },
        chat: { primary: 'gpt-oss-120b', fallback: 'gpt-oss-20b' },
      },
      providers: {
        groq: {
          name: 'Groq',
          base_url: 'https://api.groq.com/openai/v1',
          env_key: 'GROQ_API_KEY',
          credential_key: 'groqApiKey',
          rate_limits: { requests_per_minute: 30, tokens_per_minute: 100000 },
        },
      },
    };
  }

  // ==========================================================================
  // MODEL ACCESS
  // ==========================================================================

  getDefaultModel(): string {
    return this.modelsConfig?.default_model || 'gpt-oss-120b';
  }

  getModel(modelKey: string): ModelConfig | null {
    return this.modelsConfig?.models[modelKey] || null;
  }

  getModelId(modelKey: string): string | null {
    return this.modelsConfig?.models[modelKey]?.id || null;
  }

  getAvailableModels(): Array<{ key: string; config: ModelConfig }> {
    if (!this.modelsConfig) return [];
    return Object.entries(this.modelsConfig.models).map(([key, config]) => ({ key, config }));
  }

  getModelForTask(taskType: string): TaskDefault | null {
    return this.modelsConfig?.task_defaults[taskType] || null;
  }

  getProvider(providerName: string): ProviderConfig | null {
    return this.modelsConfig?.providers[providerName] || null;
  }

  // ==========================================================================
  // MODE ACCESS
  // ==========================================================================

  getMode(modeId: string): ModeConfig | null {
    return this.modes.get(modeId) || null;
  }

  getModePrompt(modeId: string, promptKey: string): ModePrompt | null {
    const mode = this.modes.get(modeId);
    if (!mode?.prompts) return null;

    const prompts = mode.prompts;
    if (promptKey in prompts) {
      const prompt = prompts[promptKey];
      // Handle nested prompts (e.g., prompts.system.base)
      if (typeof prompt === 'object' && !('system' in prompt) && !('user_template' in prompt)) {
        return null; // It's a nested object, not a prompt
      }
      return prompt as ModePrompt;
    }

    // Try nested access (e.g., "system.base")
    const parts = promptKey.split('.');
    let current: unknown = prompts;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return null;
      }
    }
    return current as ModePrompt;
  }

  getAvailableModes(): Array<{ id: string; name: string; description: string; source: string }> {
    const result: Array<{ id: string; name: string; description: string; source: string }> = [];
    for (const [id, config] of this.modes) {
      result.push({
        id,
        name: config.mode.name,
        description: config.mode.description,
        source: this.modeSources.get(id) || 'unknown',
      });
    }
    return result;
  }

  getModeSettings(modeId: string): ModeConfig['settings'] | null {
    return this.modes.get(modeId)?.settings || null;
  }

  // ==========================================================================
  // SOURCE INFORMATION
  // ==========================================================================

  getSources(): IpcResult<{
    configSources: ConfigSource[];
    activeModes: Record<string, string>;
    modelsVersion: string;
  }> {
    const activeModes: Record<string, string> = {};
    for (const [id, source] of this.modeSources) {
      activeModes[id] = source;
    }

    return {
      success: true,
      data: {
        configSources: this.configSources,
        activeModes,
        modelsVersion: this.modelsConfig?.version || '0.0.0',
      },
    };
  }

  // ==========================================================================
  // RELOAD
  // ==========================================================================

  async reload(): Promise<IpcResult<{
    status: string;
    modelCount: number;
    modeCount: number;
  }>> {
    return this.wrap(async () => {
      this.modelsConfig = null;
      this.loadAllConfigs();

      return {
        status: 'success',
        modelCount: Object.keys(this.modelsConfig?.models || {}).length,
        modeCount: this.modes.size,
      };
    }, 'CONFIG_RELOAD_FAILED');
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let registryInstance: AIConfigRegistry | null = null;

export function getAIConfigRegistry(): AIConfigRegistry {
  if (!registryInstance) {
    registryInstance = new AIConfigRegistry();
  }
  return registryInstance;
}

export function resetAIConfigRegistry(): void {
  registryInstance = null;
}

export const aiConfigRegistry = getAIConfigRegistry();
