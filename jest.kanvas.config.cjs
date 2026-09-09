/**
 * Jest Configuration for Kanvas Tests
 * Supports TypeScript and React component testing
 */

module.exports = {
  displayName: 'kanvas',
  testMatch: [
    '**/tests/kanvas/**/*.test.ts',
    '**/tests/kanvas/**/*.test.tsx',
    '**/tests/kanvas/**/*.integration.test.ts',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/.claude/worktrees/',
    '/.worktrees/',
    '/tests/kanvas/fixtures/',
    // These two integration suites are authored for Vitest (they `import from
    // 'vitest'`), not Jest. Running them under Jest fails at module resolution.
    // They belong to a separate Vitest run; ignore them here so the Jest signal
    // stays clean.
    '/tests/kanvas/integration/ContractGenerationE2E.test.ts$',
    '/tests/kanvas/integration/FeatureContractsComprehensive.test.ts$',
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/local_deploy/',
    '<rootDir>/dist/',
    '<rootDir>/test-e2e-workspace/',
    // Agent worktrees created inside the repo. Without this, jest discovers a
    // complete second copy of the tree — the whole suite runs twice, every
    // module collides in the haste map, and the pass/fail counts are junk.
    // `local_deploy/` above is the same guard for the pre-v2.6.53 layout.
    '<rootDir>/.claude/worktrees/',
    '<rootDir>/.worktrees/',
  ],
  preset: 'ts-jest/presets/default-esm',
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      useESM: true,
      // Transpile-only — do NOT type-check during the test run.
      // Rationale: stale session worktrees under local_deploy/ each ship a full
      // duplicate copy of shared/types.ts and the `declare global { Window.api }`
      // augmentation with an OLDER API shape. ts-jest's whole-program type checker
      // merges those duplicate globals, producing hundreds of bogus
      // "Property X does not exist on window.api" errors that fail entire suites
      // even though the production build (Vite/esbuild) compiles cleanly.
      // Type safety is enforced by `npm run build`; the test runner only needs to
      // execute code. isolatedModules makes ts-jest transpile each file alone.
      tsconfig: {
        jsx: 'react-jsx',
        esModuleInterop: true,
        module: 'ESNext',
        moduleResolution: 'node',
        target: 'ES2020',
        strict: false,
        skipLibCheck: true,
        allowSyntheticDefaultImports: true,
        allowJs: true,
        isolatedModules: true,
        types: ['jest', '@testing-library/jest-dom', 'node'],
      },
    }],
  },
  moduleNameMapper: {
    // Handle CSS imports
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
    // Handle path aliases
    '^@/(.*)$': '<rootDir>/renderer/$1',
    '^@electron/(.*)$': '<rootDir>/electron/$1',
    '^@shared/(.*)$': '<rootDir>/shared/$1',
  },
  setupFilesAfterEnv: [
    '<rootDir>/tests/kanvas/setup.ts',
  ],
  testEnvironment: 'jsdom',
  verbose: true,
  collectCoverage: false,
  testTimeout: 15000,
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Inject globals like jest, describe, it, expect
  injectGlobals: true,
  // Ignore haste duplicates
  haste: {
    forceNodeFilesystemAPI: true,
    enableSymlinks: false,
  },
  // Transform node_modules that need it
  transformIgnorePatterns: [
    'node_modules/(?!(zustand|@testing-library|zod)/)',
  ],
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
};
