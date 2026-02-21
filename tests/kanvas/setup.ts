/**
 * Kanvas Test Setup
 * Configures Jest environment for React and Electron testing
 */

import '@testing-library/jest-dom';
import { jest, beforeEach } from '@jest/globals';

// Make jest available globally for convenience
(globalThis as unknown as { jest: typeof jest }).jest = jest;

// Type helper for mock functions
type MockFn = ReturnType<typeof jest.fn>;

// Mock Electron APIs
const mockIpcRenderer = {
  invoke: jest.fn() as MockFn,
  send: jest.fn() as MockFn,
  on: jest.fn() as MockFn,
  once: jest.fn() as MockFn,
  removeListener: jest.fn() as MockFn,
  removeAllListeners: jest.fn() as MockFn,
};

const createMockFn = <T>(resolvedValue?: T) => {
  const fn = jest.fn() as MockFn;
  if (resolvedValue !== undefined) {
    fn.mockResolvedValue(resolvedValue as never);
  }
  return fn;
};

const mockApi = {
  agent: {
    initialize: jest.fn() as MockFn,
    list: createMockFn({ success: true, data: [] }),
    get: jest.fn() as MockFn,
    sendCommand: jest.fn() as MockFn,
    onAgentUpdate: (jest.fn() as MockFn).mockReturnValue(() => {}),
    onSessionUpdate: (jest.fn() as MockFn).mockReturnValue(() => {}),
  },
  git: {
    getCommitHistory: createMockFn({ success: true, data: [] }),
    getCommitDiff: createMockFn({ success: true, data: { commit: {}, files: [] } }),
    getChangedFiles: createMockFn({ success: true, data: [] }),
    getFilesWithStatus: createMockFn({ success: true, data: [] }),
    getDiffSummary: createMockFn({ success: true, data: { files: [] } }),
  },
  instance: {
    create: createMockFn({ success: true, data: {} }),
    validateRepo: createMockFn({
      success: true,
      data: {
        isValid: true,
        isGitRepo: true,
        repoName: 'test-repo',
        currentBranch: 'main',
        hasKanvasDir: false,
        branches: ['main', 'develop'],
      },
    }),
    initializeKanvas: createMockFn({ success: true }),
    getInstructions: createMockFn({ success: true, data: '# Instructions' }),
    launch: createMockFn({ success: true }),
    list: createMockFn({ success: true, data: [] }),
    get: createMockFn({ success: true, data: null }),
    delete: createMockFn({ success: true }),
    restart: createMockFn({ success: true, data: {} }),
    updateBaseBranch: createMockFn({ success: true }),
    getRecentRepos: createMockFn({ success: true, data: [] }),
    removeRecentRepo: createMockFn({ success: true }),
    onStatusChanged: (jest.fn() as MockFn).mockReturnValue(() => {}),
  },
  app: {
    reload: createMockFn({ success: true }),
    getVersion: createMockFn('1.2.0'),
    quit: jest.fn() as MockFn,
  },
  worker: {
    status: createMockFn({
      success: true,
      data: {
        workerAlive: true,
        workerReady: true,
        workerPid: 12345,
        restartCount: 0,
        activeMonitors: 3,
        uptimeMs: 60000,
      },
    }),
    restart: createMockFn({ success: true }),
    onStatusChanged: (jest.fn() as MockFn).mockReturnValue(() => {}),
  },
  recentRepos: {
    list: createMockFn({ success: true, data: [] }),
    add: createMockFn({ success: true }),
    remove: createMockFn({ success: true }),
  },
  config: {
    get: jest.fn() as MockFn,
    set: jest.fn() as MockFn,
  },
  shell: {
    openExternal: jest.fn() as MockFn,
    openPath: jest.fn() as MockFn,
  },
  dialog: {
    showOpenDialog: createMockFn({ canceled: false, filePaths: ['/test/path'] }),
    openDirectory: createMockFn({ canceled: false, filePaths: ['/test/path'] }),
  },
  ai: {
    onEnd: (jest.fn() as MockFn).mockReturnValue(() => {}),
    onStream: (jest.fn() as MockFn).mockReturnValue(() => {}),
  },
};

// Set up window.api mock
Object.defineProperty(window, 'api', {
  value: mockApi,
  writable: true,
  configurable: true,
});

// Mock navigator.clipboard
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: (jest.fn() as MockFn).mockResolvedValue(undefined as never),
    readText: (jest.fn() as MockFn).mockResolvedValue('' as never),
  },
  writable: true,
  configurable: true,
});

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// Export mocks for test use
export { mockApi, mockIpcRenderer };
