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
    '/tests/kanvas/fixtures/',
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/local_deploy/',
    '<rootDir>/dist/',
    '<rootDir>/test-e2e-workspace/',
  ],
  preset: 'ts-jest/presets/default-esm',
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      useESM: true,
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
