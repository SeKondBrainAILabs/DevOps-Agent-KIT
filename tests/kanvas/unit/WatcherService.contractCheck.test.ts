/**
 * Unit Tests for WatcherService — Commit-Level Contract Checks
 * Tests the triggerCommitContractCheck flow, setContractServices wiring,
 * activity feed logging, and IPC emission for contract auto-updates.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { IpcResult, DiscoveredFeature } from '../../../shared/types';
import { IPC } from '../../../shared/ipc-channels';

// ─── Mocks: external modules (must be before imports) ────────────────────────

jest.mock('chokidar', () => ({
  default: {
    watch: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      close: jest.fn().mockResolvedValue(undefined as never),
    })),
  },
}));

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn(() => false),
    promises: {
      readFile: jest.fn().mockResolvedValue('' as never),
      writeFile: jest.fn().mockResolvedValue(undefined as never),
    },
  };
});

const mockGetSetting = jest.fn();
const mockRecordCommit = jest.fn();
const mockRecordSessionEvent = jest.fn();

jest.mock('../../../electron/services/DatabaseService', () => ({
  databaseService: {
    getSetting: (...args: unknown[]) => mockGetSetting(...args),
    setSetting: jest.fn(),
    recordCommit: (...args: unknown[]) => mockRecordCommit(...args),
    recordSessionEvent: (...args: unknown[]) => mockRecordSessionEvent(...args),
  },
}));

// ─── Typed mock function signatures ──────────────────────────────────────────

type AnalyzeCommitFn = (
  repoPath: string,
  commitHash?: string
) => Promise<IpcResult<{
  commitHash: string;
  commitMessage: string;
  timestamp: string;
  hasContractChanges: boolean;
  changes: Array<{
    file: string;
    type: string;
    changeType: string;
    additions: number;
    deletions: number;
    impactLevel: string;
  }>;
  breakingChanges: Array<{
    file: string;
    type: string;
    changeType: string;
    additions: number;
    deletions: number;
    impactLevel: string;
  }>;
  summary: string;
  recommendations: string[];
}>>;

type GenerateFeatureContractFn = (
  repoPath: string,
  feature: DiscoveredFeature
) => Promise<IpcResult<unknown>>;

// ─── Service mocks ───────────────────────────────────────────────────────────

const mockAnalyzeCommit = jest.fn<AnalyzeCommitFn>();
const mockContractDetectionService = {
  analyzeCommit: mockAnalyzeCommit,
};

const mockGenerateFeatureContract = jest.fn<GenerateFeatureContractFn>();
const mockContractGenerationService = {
  generateFeatureContract: mockGenerateFeatureContract,
};

const mockActivityLog = jest.fn();
const mockLogFileActivity = jest.fn();
const mockLinkToCommit = jest.fn(() => 0);

const mockActivityService = {
  log: mockActivityLog,
  logFileActivity: mockLogFileActivity,
  linkToCommit: mockLinkToCommit,
};

const mockGitService = {
  registerWorktree: jest.fn(),
  commit: jest.fn().mockResolvedValue({
    success: true,
    data: { hash: 'abc123def', shortHash: 'abc123' },
  } as never),
  getStatus: jest.fn().mockResolvedValue({
    success: true,
    data: { changes: [] },
  } as never),
  push: jest.fn().mockResolvedValue({ success: true } as never),
};

// ─── Import after mocking ────────────────────────────────────────────────────

import { WatcherService } from '../../../electron/services/WatcherService';
import { existsSync } from 'fs';

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;

// ─── Test fixtures ───────────────────────────────────────────────────────────

const TEST_SESSION_ID = 'sess_test123';
const TEST_WORKTREE = '/repos/myapp/local_deploy/feature-branch';
const TEST_REPO_PATH = '/repos/myapp';
const TEST_COMMIT_HASH = 'a1b2c3d4e5f6';

function makeWatcherInstance() {
  return {
    sessionId: TEST_SESSION_ID,
    worktreePath: TEST_WORKTREE,
    repoPath: TEST_REPO_PATH,
    agentType: 'claude' as const,
    branchName: 'feature-branch',
    watcher: { on: jest.fn().mockReturnThis(), close: jest.fn() },
    commitMsgFile: `${TEST_WORKTREE}/.devops-commit-test1234.msg`,
    claudeCommitMsgFile: `${TEST_WORKTREE}/.claude-commit-msg`,
  };
}

function makeFeature(name: string, relPath: string): DiscoveredFeature {
  return {
    name,
    description: `${name} feature`,
    basePath: `${TEST_REPO_PATH}/${relPath}`,
    files: {
      api: [`${relPath}/routes/index.ts`],
      schema: [`${relPath}/types.ts`],
      tests: { e2e: [], unit: [], integration: [] },
      fixtures: [],
      config: [],
      css: [],
      prompts: [],
      other: [],
    },
    contractPatternMatches: 2,
  };
}

function makeAnalysisResult(
  hasChanges: boolean,
  files: string[] = [],
  breaking: string[] = []
) {
  return {
    success: true as const,
    data: {
      commitHash: TEST_COMMIT_HASH,
      commitMessage: 'feat: update auth',
      timestamp: new Date().toISOString(),
      hasContractChanges: hasChanges,
      changes: files.map(f => ({
        file: f,
        type: 'typeDefinition',
        changeType: 'modified',
        additions: 10,
        deletions: 3,
        impactLevel: 'non-breaking',
      })),
      breakingChanges: breaking.map(f => ({
        file: f,
        type: 'typeDefinition',
        changeType: 'modified',
        additions: 5,
        deletions: 8,
        impactLevel: 'breaking',
      })),
      summary: 'Contract changes detected',
      recommendations: [],
    },
  };
}

const AUTH_FEATURE = makeFeature('Auth Service', 'backend/auth');
const USER_FEATURE = makeFeature('User Management', 'backend/users');
const FRONTEND_FEATURE = makeFeature('Frontend App', 'frontend/app');

// ─── Test suites ─────────────────────────────────────────────────────────────

describe('WatcherService — Commit-Level Contract Checks', () => {
  let service: WatcherService;
  let mockEmitToRenderer: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    service = new WatcherService(
      mockGitService as any,
      mockActivityService as any
    );

    // Wire contract services
    service.setContractServices(
      mockContractDetectionService as any,
      mockContractGenerationService as any
    );

    // Mock emitToRenderer from BaseService
    mockEmitToRenderer = jest.fn();
    (service as any).emitToRenderer = mockEmitToRenderer;

    // Default: meta file exists
    mockExistsSync.mockReturnValue(true);

    // Default: generation succeeds
    mockGenerateFeatureContract.mockResolvedValue({
      success: true,
      data: { contractPath: '/some/path.json' },
    });

    // Default: no cached features (override per test)
    mockGetSetting.mockReturnValue([]);
  });

  afterEach(async () => {
    await service.dispose();
  });

  // ── setContractServices ──────────────────────────────────────────────────

  describe('setContractServices', () => {
    it('should store both contract services', () => {
      const fresh = new WatcherService(mockGitService as any, mockActivityService as any);
      fresh.setContractServices(
        mockContractDetectionService as any,
        mockContractGenerationService as any
      );

      expect((fresh as any).contractDetectionService).toBe(mockContractDetectionService);
      expect((fresh as any).contractGenerationService).toBe(mockContractGenerationService);
    });

    it('should log configuration message', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const fresh = new WatcherService(mockGitService as any, mockActivityService as any);
      fresh.setContractServices(
        mockContractDetectionService as any,
        mockContractGenerationService as any
      );

      expect(spy).toHaveBeenCalledWith(
        '[WatcherService] Contract services configured for auto-check'
      );
      spy.mockRestore();
    });
  });

  // ── Guard: services not wired ────────────────────────────────────────────

  describe('guard: contract services not wired', () => {
    it('should return immediately when detection service is null', async () => {
      const unwired = new WatcherService(mockGitService as any, mockActivityService as any);
      // Don't call setContractServices

      const instance = makeWatcherInstance();
      await (unwired as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockAnalyzeCommit).not.toHaveBeenCalled();
      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it('should return immediately when generation service is null', async () => {
      const partial = new WatcherService(mockGitService as any, mockActivityService as any);
      (partial as any).contractDetectionService = mockContractDetectionService;
      // contractGenerationService remains null

      const instance = makeWatcherInstance();
      await (partial as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockAnalyzeCommit).not.toHaveBeenCalled();
    });
  });

  // ── Guard: meta file ─────────────────────────────────────────────────────

  describe('guard: contract meta file', () => {
    it('should skip when .contract-generation-meta.json does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockExistsSync).toHaveBeenCalledWith(
        `${TEST_WORKTREE}/.devops-kit/.contract-generation-meta.json`
      );
      expect(mockAnalyzeCommit).not.toHaveBeenCalled();
    });

    it('should proceed when meta file exists', async () => {
      mockExistsSync.mockReturnValue(true);
      mockAnalyzeCommit.mockResolvedValue(makeAnalysisResult(false));

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockAnalyzeCommit).toHaveBeenCalledWith(TEST_WORKTREE, TEST_COMMIT_HASH);
    });
  });

  // ── Guard: overlapping runs ──────────────────────────────────────────────

  describe('guard: overlapping runs', () => {
    it('should prevent concurrent checks for the same session', async () => {
      // Make analyzeCommit hang so we can test concurrency
      let resolveAnalysis!: (v: any) => void;
      mockAnalyzeCommit.mockImplementation(
        () => new Promise(resolve => { resolveAnalysis = resolve; })
      );

      const instance = makeWatcherInstance();

      // Start first check (will hang on analyzeCommit)
      const first = (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      // Start second check immediately — should bail
      const second = (service as any).triggerCommitContractCheck(instance, 'deadbeef');

      // Resolve the first
      resolveAnalysis(makeAnalysisResult(false));
      await first;
      await second;

      // analyzeCommit should only have been called once
      expect(mockAnalyzeCommit).toHaveBeenCalledTimes(1);
    });

    it('should clear in-progress flag after completion', async () => {
      mockAnalyzeCommit.mockResolvedValue(makeAnalysisResult(false));

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect((service as any).contractCheckInProgress.has(TEST_SESSION_ID)).toBe(false);
    });

    it('should clear in-progress flag even on error', async () => {
      mockAnalyzeCommit.mockRejectedValue(new Error('git failed'));

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect((service as any).contractCheckInProgress.has(TEST_SESSION_ID)).toBe(false);
    });

    it('should allow different sessions to run concurrently', async () => {
      mockAnalyzeCommit.mockResolvedValue(makeAnalysisResult(false));

      const instance1 = makeWatcherInstance();
      const instance2 = { ...makeWatcherInstance(), sessionId: 'sess_other456' };

      await Promise.all([
        (service as any).triggerCommitContractCheck(instance1, TEST_COMMIT_HASH),
        (service as any).triggerCommitContractCheck(instance2, TEST_COMMIT_HASH),
      ]);

      expect(mockAnalyzeCommit).toHaveBeenCalledTimes(2);
    });
  });

  // ── Guard: no contract changes ───────────────────────────────────────────

  describe('guard: no contract changes in commit', () => {
    it('should skip when analyzeCommit returns hasContractChanges=false', async () => {
      mockAnalyzeCommit.mockResolvedValue(makeAnalysisResult(false));

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGetSetting).not.toHaveBeenCalled();
      expect(mockGenerateFeatureContract).not.toHaveBeenCalled();
    });

    it('should skip when analyzeCommit fails', async () => {
      mockAnalyzeCommit.mockResolvedValue({
        success: false,
        error: { code: 'ANALYSIS_FAILED', message: 'Git error' },
      });

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGetSetting).not.toHaveBeenCalled();
    });

    it('should skip when analyzeCommit returns no data', async () => {
      mockAnalyzeCommit.mockResolvedValue({ success: true, data: undefined });

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGetSetting).not.toHaveBeenCalled();
    });
  });

  // ── Guard: no cached features ────────────────────────────────────────────

  describe('guard: no cached features', () => {
    it('should skip when no discovered features are cached', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/types.ts'])
      );
      mockGetSetting.mockReturnValue([]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGetSetting).toHaveBeenCalledWith(
        `discovered_features:${TEST_REPO_PATH}`,
        []
      );
      expect(mockGenerateFeatureContract).not.toHaveBeenCalled();
    });

    it('should skip when getSetting returns null', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/types.ts'])
      );
      mockGetSetting.mockReturnValue(null);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGenerateFeatureContract).not.toHaveBeenCalled();
    });

    it('should use worktreePath as effectiveRepoPath when repoPath is empty', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/types.ts'])
      );
      mockGetSetting.mockReturnValue([]);

      const instance = { ...makeWatcherInstance(), repoPath: '' };
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGetSetting).toHaveBeenCalledWith(
        `discovered_features:${TEST_WORKTREE}`,
        []
      );
    });
  });

  // ── Guard: no affected features ──────────────────────────────────────────

  describe('guard: no affected features', () => {
    it('should skip when changed files do not match any feature basePath', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['docs/readme.md', 'scripts/deploy.sh'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE, USER_FEATURE]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGenerateFeatureContract).not.toHaveBeenCalled();
      expect(mockActivityLog).not.toHaveBeenCalledWith(
        expect.anything(),
        'info',
        expect.stringContaining('Contracts updated'),
        expect.anything()
      );
    });
  });

  // ── Feature matching ─────────────────────────────────────────────────────

  describe('feature matching', () => {
    it('should match changed files to features by path prefix', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/routes/login.ts'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE, USER_FEATURE, FRONTEND_FEATURE]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      // Only Auth Service should be regenerated
      expect(mockGenerateFeatureContract).toHaveBeenCalledTimes(1);
      expect(mockGenerateFeatureContract).toHaveBeenCalledWith(
        TEST_WORKTREE,
        AUTH_FEATURE
      );
    });

    it('should match multiple features when files span multiple feature paths', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, [
          'backend/auth/types.ts',
          'backend/users/schema.prisma',
        ])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE, USER_FEATURE, FRONTEND_FEATURE]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGenerateFeatureContract).toHaveBeenCalledTimes(2);
      expect(mockGenerateFeatureContract).toHaveBeenCalledWith(TEST_WORKTREE, AUTH_FEATURE);
      expect(mockGenerateFeatureContract).toHaveBeenCalledWith(TEST_WORKTREE, USER_FEATURE);
    });

    it('should not match a file at the same level as basePath (needs subpath)', async () => {
      // File "backend/auth" without a trailing separator should NOT match
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      // "backend/auth" does not start with "backend/auth/" so no match
      expect(mockGenerateFeatureContract).not.toHaveBeenCalled();
    });

    it('should not false-match a feature with a similar prefix', async () => {
      // "backend/auth-legacy/foo.ts" should NOT match "backend/auth"
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth-legacy/foo.ts'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGenerateFeatureContract).not.toHaveBeenCalled();
    });
  });

  // ── Contract regeneration ────────────────────────────────────────────────

  describe('contract regeneration', () => {
    it('should call generateFeatureContract for each affected feature', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/routes/login.ts', 'backend/users/model.ts'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE, USER_FEATURE]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGenerateFeatureContract).toHaveBeenCalledTimes(2);
    });

    it('should collect only successfully updated feature names', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/x.ts', 'backend/users/y.ts'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE, USER_FEATURE]);

      // Auth succeeds, Users fails
      mockGenerateFeatureContract
        .mockResolvedValueOnce({ success: true, data: {} })
        .mockResolvedValueOnce({ success: false, error: { code: 'GEN_FAIL', message: 'err' } });

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      // Activity log should only mention Auth Service
      expect(mockActivityLog).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        'info',
        expect.stringContaining('Auth Service'),
        expect.objectContaining({
          updatedFeatures: ['Auth Service'],
        })
      );
    });

    it('should continue processing remaining features when one throws', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/x.ts', 'backend/users/y.ts'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE, USER_FEATURE]);

      // Auth throws, Users succeeds
      mockGenerateFeatureContract
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ success: true, data: {} });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      // Both were attempted
      expect(mockGenerateFeatureContract).toHaveBeenCalledTimes(2);
      // Only User Management logged
      expect(mockActivityLog).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        'info',
        expect.stringContaining('User Management'),
        expect.anything()
      );
      // Warning for Auth
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Contract update failed for Auth Service'),
        expect.any(Error)
      );
      warnSpy.mockRestore();
    });

    it('should not log or emit when all regenerations fail', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/x.ts'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE]);
      mockGenerateFeatureContract.mockRejectedValue(new Error('boom'));

      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockActivityLog).not.toHaveBeenCalledWith(
        expect.anything(),
        'info',
        expect.stringContaining('Contracts updated'),
        expect.anything()
      );
      expect(mockEmitToRenderer).not.toHaveBeenCalledWith(
        IPC.CONTRACT_CHANGES_DETECTED,
        expect.anything()
      );
      jest.restoreAllMocks();
    });
  });

  // ── Activity feed logging ────────────────────────────────────────────────

  describe('activity feed logging', () => {
    beforeEach(() => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, [
          'backend/auth/routes/login.ts',
          'backend/auth/types.ts',
          'backend/auth/schema.prisma',
        ])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE]);
    });

    it('should log to activity feed with correct session, type, and message', async () => {
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockActivityLog).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        'info',
        expect.stringContaining('Contracts updated for 1 feature(s): Auth Service'),
        expect.any(Object)
      );
    });

    it('should include file basenames in the message', async () => {
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      const message = mockActivityLog.mock.calls[0][2] as string;
      expect(message).toContain('login.ts');
      expect(message).toContain('types.ts');
      expect(message).toContain('schema.prisma');
    });

    it('should include file count in the message', async () => {
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      const message = mockActivityLog.mock.calls[0][2] as string;
      expect(message).toContain('3 files');
    });

    it('should truncate file list at 5 and show +N more', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, [
          'backend/auth/a.ts',
          'backend/auth/b.ts',
          'backend/auth/c.ts',
          'backend/auth/d.ts',
          'backend/auth/e.ts',
          'backend/auth/f.ts',
          'backend/auth/g.ts',
        ])
      );

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      const message = mockActivityLog.mock.calls[0][2] as string;
      expect(message).toContain('+2 more');
      expect(message).toContain('7 files');
      // Should show first 5 basenames
      expect(message).toContain('a.ts');
      expect(message).toContain('e.ts');
      // Should NOT show 6th and 7th
      expect(message).not.toContain('f.ts');
      expect(message).not.toContain('g.ts');
    });

    it('should not show +N more when exactly 5 files', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, [
          'backend/auth/a.ts',
          'backend/auth/b.ts',
          'backend/auth/c.ts',
          'backend/auth/d.ts',
          'backend/auth/e.ts',
        ])
      );

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      const message = mockActivityLog.mock.calls[0][2] as string;
      expect(message).not.toContain('+');
      expect(message).toContain('5 files');
    });

    it('should include metadata with correct structure', async () => {
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      const metadata = mockActivityLog.mock.calls[0][3] as Record<string, unknown>;
      expect(metadata).toEqual({
        type: 'contract-auto-update',
        commitHash: TEST_COMMIT_HASH,
        updatedFeatures: ['Auth Service'],
        filesChanged: [
          'backend/auth/routes/login.ts',
          'backend/auth/types.ts',
          'backend/auth/schema.prisma',
        ],
        breakingChanges: 0,
      });
    });

    it('should include breaking change count in metadata', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(
          true,
          ['backend/auth/types.ts'],
          ['backend/auth/types.ts'] // same file is breaking
        )
      );

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      const metadata = mockActivityLog.mock.calls[0][3] as Record<string, unknown>;
      expect(metadata.breakingChanges).toBe(1);
    });
  });

  // ── IPC emission ─────────────────────────────────────────────────────────

  describe('IPC emission', () => {
    beforeEach(() => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/types.ts'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE]);
    });

    it('should emit CONTRACT_CHANGES_DETECTED to renderer', async () => {
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockEmitToRenderer).toHaveBeenCalledWith(
        IPC.CONTRACT_CHANGES_DETECTED,
        expect.objectContaining({
          repoPath: TEST_WORKTREE,
          commitHash: TEST_COMMIT_HASH,
          updatedFeatures: ['Auth Service'],
          hasBreakingChanges: false,
        })
      );
    });

    it('should set hasBreakingChanges=true when breaking changes exist', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(
          true,
          ['backend/auth/types.ts'],
          ['backend/auth/types.ts']
        )
      );

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockEmitToRenderer).toHaveBeenCalledWith(
        IPC.CONTRACT_CHANGES_DETECTED,
        expect.objectContaining({
          hasBreakingChanges: true,
        })
      );
    });

    it('should include all successfully updated features in emission', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, [
          'backend/auth/types.ts',
          'backend/users/model.ts',
        ])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE, USER_FEATURE]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockEmitToRenderer).toHaveBeenCalledWith(
        IPC.CONTRACT_CHANGES_DETECTED,
        expect.objectContaining({
          updatedFeatures: ['Auth Service', 'User Management'],
        })
      );
    });

    it('should not emit when no features were successfully updated', async () => {
      mockGenerateFeatureContract.mockResolvedValue({
        success: false,
        error: { code: 'FAIL', message: 'err' },
      });

      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockEmitToRenderer).not.toHaveBeenCalledWith(
        IPC.CONTRACT_CHANGES_DETECTED,
        expect.anything()
      );
      jest.restoreAllMocks();
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should catch and log errors without propagating', async () => {
      mockAnalyzeCommit.mockRejectedValue(new Error('git process died'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const instance = makeWatcherInstance();

      // Should NOT throw
      await expect(
        (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH)
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        '[WatcherService] Contract auto-check error:',
        expect.any(Error)
      );
      errorSpy.mockRestore();
    });

    it('should still clear in-progress flag when error occurs mid-flow', async () => {
      // getSetting throws after analyzeCommit succeeds
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/types.ts'])
      );
      mockGetSetting.mockImplementation(() => {
        throw new Error('DB corrupted');
      });

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect((service as any).contractCheckInProgress.has(TEST_SESSION_ID)).toBe(false);
      errorSpy.mockRestore();
    });
  });

  // ── Console logging ──────────────────────────────────────────────────────

  describe('console logging', () => {
    it('should log affected feature count with short commit hash', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/x.ts', 'backend/users/y.ts'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE, USER_FEATURE]);

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Commit ${TEST_COMMIT_HASH.substring(0, 7)} affects 2 feature(s)`)
      );
      logSpy.mockRestore();
    });
  });

  // ── Integration: full happy path ─────────────────────────────────────────

  describe('full happy path', () => {
    it('should detect, regenerate, log, and emit for a multi-feature commit', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(
          true,
          ['backend/auth/routes/login.ts', 'backend/users/schema.prisma', 'frontend/app/page.tsx'],
          ['backend/users/schema.prisma']
        )
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE, USER_FEATURE, FRONTEND_FEATURE]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      // Step 1: analyzeCommit called
      expect(mockAnalyzeCommit).toHaveBeenCalledWith(TEST_WORKTREE, TEST_COMMIT_HASH);

      // Step 2: features loaded from DB
      expect(mockGetSetting).toHaveBeenCalledWith(
        `discovered_features:${TEST_REPO_PATH}`,
        []
      );

      // Step 3: all 3 affected features regenerated
      expect(mockGenerateFeatureContract).toHaveBeenCalledTimes(3);
      expect(mockGenerateFeatureContract).toHaveBeenCalledWith(TEST_WORKTREE, AUTH_FEATURE);
      expect(mockGenerateFeatureContract).toHaveBeenCalledWith(TEST_WORKTREE, USER_FEATURE);
      expect(mockGenerateFeatureContract).toHaveBeenCalledWith(TEST_WORKTREE, FRONTEND_FEATURE);

      // Step 4: activity logged with all 3 features
      expect(mockActivityLog).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        'info',
        expect.stringContaining('3 feature(s)'),
        expect.objectContaining({
          type: 'contract-auto-update',
          commitHash: TEST_COMMIT_HASH,
          updatedFeatures: ['Auth Service', 'User Management', 'Frontend App'],
          breakingChanges: 1,
        })
      );

      // Step 5: IPC emitted with breaking changes flag
      expect(mockEmitToRenderer).toHaveBeenCalledWith(
        IPC.CONTRACT_CHANGES_DETECTED,
        expect.objectContaining({
          repoPath: TEST_WORKTREE,
          commitHash: TEST_COMMIT_HASH,
          updatedFeatures: ['Auth Service', 'User Management', 'Frontend App'],
          hasBreakingChanges: true,
        })
      );
    });

    it('should handle single-feature single-file commit', async () => {
      mockAnalyzeCommit.mockResolvedValue(
        makeAnalysisResult(true, ['backend/auth/middleware.ts'])
      );
      mockGetSetting.mockReturnValue([AUTH_FEATURE]);

      const instance = makeWatcherInstance();
      await (service as any).triggerCommitContractCheck(instance, TEST_COMMIT_HASH);

      expect(mockGenerateFeatureContract).toHaveBeenCalledTimes(1);
      expect(mockActivityLog).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        'info',
        expect.stringContaining('1 feature(s): Auth Service (1 files: middleware.ts)'),
        expect.anything()
      );
    });
  });
});
