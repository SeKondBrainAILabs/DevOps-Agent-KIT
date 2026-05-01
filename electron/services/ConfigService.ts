/**
 * Config Service
 * Application settings and credentials management
 * Migrated from: branch-config-manager.js + credentials-manager.js
 */

import { BaseService } from './BaseService';
import type {
  AppConfig,
  BranchManagementSettings,
  Credentials,
  IpcResult,
  RepoWorkspaceConfig,
  WorktreeMode,
} from '../../shared/types';
import Store from 'electron-store';

interface StoreSchema {
  config: AppConfig;
  credentials: Credentials;
  branchSettings: BranchManagementSettings;
  /** Per-repo workspace settings keyed by absolute repo path. */
  repoSettings: Record<string, RepoWorkspaceConfig>;
}

const DEFAULT_WORKTREE_MODE: WorktreeMode = 'worktree';

const defaultConfig: AppConfig = {
  theme: 'dark',
  defaultAgentType: 'claude',
  recentProjects: [],
  autoWatch: true,
  autoPush: true,
  onboardingCompleted: false,
  // O5: opt-in default is false — telemetry stays off until user agrees.
  telemetryOptIn: false,
  // L4: default landing view — 'last-visited' so existing users see no surprise.
  defaultLandingView: 'last-visited',
};

const defaultBranchSettings: BranchManagementSettings = {
  defaultMergeTarget: 'main',
  enableDualMerge: false,
  enableWeeklyConsolidation: true,
  orphanSessionThresholdDays: 7,
  mergeStrategy: 'hierarchical-first',
  conflictResolution: 'prompt',
};

export class ConfigService extends BaseService {
  private store: Store<StoreSchema>;

  constructor() {
    super();
    this.store = new Store<StoreSchema>({
      name: 'sekondbrain-kanvas',
      defaults: {
        config: defaultConfig,
        credentials: {},
        branchSettings: defaultBranchSettings,
        repoSettings: {},
      },
      // Simple obfuscation for credentials (not strong encryption)
      encryptionKey: 'sekondbrain-kanvas-v1',
    });
  }

  async initialize(): Promise<void> {
    // Migrate old config if exists
    // (Could check for ~/.devops-agent/credentials.json and migrate)
  }

  // ==========================================================================
  // APP CONFIG
  // ==========================================================================

  get<K extends keyof AppConfig>(key: K): IpcResult<AppConfig[K]> {
    try {
      const config = this.store.get('config');
      return this.success(config[key]);
    } catch (error) {
      return this.error('CONFIG_GET_FAILED', 'Failed to get config');
    }
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): IpcResult<void> {
    try {
      const config = this.store.get('config');
      config[key] = value;
      this.store.set('config', config);
      return this.success(undefined);
    } catch (error) {
      return this.error('CONFIG_SET_FAILED', 'Failed to set config');
    }
  }

  getAll(): IpcResult<AppConfig> {
    try {
      return this.success(this.store.get('config'));
    } catch (error) {
      return this.error('CONFIG_GET_ALL_FAILED', 'Failed to get all config');
    }
  }

  // ==========================================================================
  // CREDENTIALS
  // ==========================================================================

  getCredential(key: keyof Credentials): IpcResult<string | null> {
    try {
      const credentials = this.store.get('credentials');
      const value = credentials[key];
      return this.success(typeof value === 'string' ? value : null);
    } catch (error) {
      return this.error('CREDENTIAL_GET_FAILED', 'Failed to get credential');
    }
  }

  setCredential(key: keyof Credentials, value: string): IpcResult<void> {
    try {
      const credentials = this.store.get('credentials');
      credentials[key] = value;
      credentials.updatedAt = new Date().toISOString();
      this.store.set('credentials', credentials);
      return this.success(undefined);
    } catch (error) {
      return this.error('CREDENTIAL_SET_FAILED', 'Failed to set credential');
    }
  }

  hasCredential(key: keyof Credentials): IpcResult<boolean> {
    try {
      const credentials = this.store.get('credentials');
      return this.success(!!credentials[key]);
    } catch (error) {
      return this.error('CREDENTIAL_HAS_FAILED', 'Failed to check credential');
    }
  }

  /**
   * Get raw credential value (for internal use by AIService)
   */
  getCredentialValue(key: keyof Credentials): string | undefined {
    const credentials = this.store.get('credentials');
    const value = credentials[key];
    return typeof value === 'string' ? value : undefined;
  }

  // ==========================================================================
  // BRANCH SETTINGS
  // ==========================================================================

  getBranchSettings(): BranchManagementSettings {
    return this.store.get('branchSettings');
  }

  setBranchSettings(settings: Partial<BranchManagementSettings>): void {
    const current = this.store.get('branchSettings');
    this.store.set('branchSettings', { ...current, ...settings });
  }

  // ==========================================================================
  // PER-REPO WORKSPACE SETTINGS (C5 Single-Session Mode)
  // ==========================================================================

  /**
   * Get the worktree mode for a repo.
   * Defaults to 'worktree' (multi-session) when not previously set.
   */
  getRepoWorktreeMode(repoPath: string): WorktreeMode {
    const settings = this.store.get('repoSettings');
    return settings?.[repoPath]?.worktreeMode ?? DEFAULT_WORKTREE_MODE;
  }

  /**
   * Set the worktree mode for a repo.
   * 'in-place' enables Single-Session Mode (system blocks creating a 2nd active session).
   * 'worktree' enables multi-session mode (default).
   */
  setRepoWorktreeMode(repoPath: string, mode: WorktreeMode): void {
    const settings = { ...(this.store.get('repoSettings') ?? {}) };
    settings[repoPath] = {
      repoPath,
      worktreeMode: mode,
      lastUpdated: new Date().toISOString(),
    };
    this.store.set('repoSettings', settings);
  }

  /**
   * Get the full per-repo workspace config record (or null if not set).
   */
  getRepoConfig(repoPath: string): RepoWorkspaceConfig | null {
    const settings = this.store.get('repoSettings');
    return settings?.[repoPath] ?? null;
  }

  // ==========================================================================
  // RECENT PROJECTS
  // ==========================================================================

  addRecentProject(projectPath: string): void {
    const config = this.store.get('config');
    const recent = config.recentProjects.filter((p) => p !== projectPath);
    recent.unshift(projectPath);
    config.recentProjects = recent.slice(0, 10); // Keep last 10
    this.store.set('config', config);
  }

  clearRecentProjects(): void {
    const config = this.store.get('config');
    config.recentProjects = [];
    this.store.set('config', config);
  }
}
