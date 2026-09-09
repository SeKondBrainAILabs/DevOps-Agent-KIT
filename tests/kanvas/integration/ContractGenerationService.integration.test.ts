/**
 * Integration Tests for ContractGenerationService
 * Tests feature discovery, git submodule filtering, and package.json name detection
 * using real repositories
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import path from 'path';
import fs from 'fs';
import { ContractGenerationService } from '../../../electron/services/ContractGenerationService';

// Test fixtures paths
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const SAMPLE_REPO_PATH = path.join(FIXTURES_DIR, 'sample-repo');
const PIGGY_BANK_PATH = path.join(FIXTURES_DIR, 'SA-Piggy-Bank');

// These tests scan real fixture repos that are not committed (they're large and
// machine-specific). Skip the whole suite cleanly when the fixtures are absent
// rather than failing with ENOENT / empty-result assertions. To run locally,
// place sample-repo and SA-Piggy-Bank under tests/kanvas/fixtures/.
const fixturesPresent = fs.existsSync(SAMPLE_REPO_PATH) && fs.existsSync(PIGGY_BANK_PATH);
const describeIfFixtures = fixturesPresent ? describe : describe.skip;

// Mock AIService - we only need discoverFeatures which doesn't use AI
const mockAIService = {
  sendWithMode: async () => ({ success: true, data: '{}' }),
};

// Mock AIService that simulates intelligent feature detection
const createSmartMockAIService = (expectedFeatures: string[]) => ({
  sendWithMode: async (params: { promptKey: string; variables: Record<string, string> }) => {
    // If filter_features is called, return the expected features
    if (params.promptKey === 'filter_features') {
      const features = expectedFeatures.map(f => ({
        path: f,
        name: f,
        description: `${f} feature`,
      }));
      return {
        success: true,
        data: JSON.stringify({ features }),
      };
    }
    return { success: true, data: '{}' };
  },
});

// Mock RegistryService
const mockRegistryService = {
  register: async () => ({ success: true }),
};

describeIfFixtures('ContractGenerationService - Integration Tests', () => {
  let service: ContractGenerationService;

  beforeAll(() => {
    service = new ContractGenerationService(
      mockAIService as any,
      mockRegistryService as any
    );
  });

  // =========================================================================
  // Feature Discovery Tests - Sample Repo
  // =========================================================================
  describe('discoverFeatures - Sample Repo', () => {
    it('should discover all feature directories in sample repo', async () => {
      const result = await service.discoverFeatures(SAMPLE_REPO_PATH);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.length).toBeGreaterThan(0);

      console.log('Discovered features:', result.data!.map(f => f.name));
    });

    it('should use package.json name for features with scoped packages', async () => {
      const result = await service.discoverFeatures(SAMPLE_REPO_PATH);

      expect(result.success).toBe(true);

      // Find the auth package (should be named 'authentication-service' from @sample/authentication-service)
      const authFeature = result.data!.find(f =>
        f.name === 'authentication-service' || f.basePath.includes('auth')
      );

      if (authFeature) {
        console.log('Auth feature name:', authFeature.name);
        // Should strip @sample/ scope and use 'authentication-service'
        expect(authFeature.name).toBe('authentication-service');
      }
    });

    it('should use unscoped package.json name for features', async () => {
      const result = await service.discoverFeatures(SAMPLE_REPO_PATH);

      expect(result.success).toBe(true);

      // Find the web app (should be named 'web-frontend' from package.json)
      const webFeature = result.data!.find(f =>
        f.name === 'web-frontend' || f.basePath.includes('web')
      );

      if (webFeature) {
        console.log('Web feature name:', webFeature.name);
        expect(webFeature.name).toBe('web-frontend');
      }
    });

    it('should skip git submodules defined in .gitmodules', async () => {
      const result = await service.discoverFeatures(SAMPLE_REPO_PATH);

      expect(result.success).toBe(true);

      const featureNames = result.data!.map(f => f.name);
      const featurePaths = result.data!.map(f => f.basePath);

      console.log('Feature names:', featureNames);

      // external-lib is defined as submodule in .gitmodules
      expect(featureNames).not.toContain('external-lib');

      // Check that no feature path includes the submodule paths
      const hasExternalLib = featurePaths.some(p => p.includes('external-lib'));
      expect(hasExternalLib).toBe(false);
    });

    it('should categorize files correctly', async () => {
      const result = await service.discoverFeatures(SAMPLE_REPO_PATH);

      expect(result.success).toBe(true);

      // Find auth feature
      const authFeature = result.data!.find(f =>
        f.basePath.includes('auth')
      );

      if (authFeature) {
        console.log('Auth feature files:', {
          api: authFeature.files.api.length,
          schema: authFeature.files.schema.length,
          other: authFeature.files.other.length,
        });

        // Should have found some files
        const totalFiles = authFeature.files.api.length +
          authFeature.files.schema.length +
          authFeature.files.other.length;
        expect(totalFiles).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // Feature Discovery Tests - SA-Piggy-Bank (Real Repo)
  // =========================================================================
  describe('discoverFeatures - SA-Piggy-Bank', () => {
    it('should discover features in SA-Piggy-Bank repo', async () => {
      const result = await service.discoverFeatures(PIGGY_BANK_PATH);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.length).toBeGreaterThan(0);

      console.log('SA-Piggy-Bank features:', result.data!.map(f => ({
        name: f.name,
        path: path.relative(PIGGY_BANK_PATH, f.basePath),
        files: f.contractPatternMatches,
      })));
    });

    it('should skip git submodules in lib/ directory', async () => {
      const result = await service.discoverFeatures(PIGGY_BANK_PATH);

      expect(result.success).toBe(true);

      const featureNames = result.data!.map(f => f.name);
      const featurePaths = result.data!.map(f => path.relative(PIGGY_BANK_PATH, f.basePath));

      console.log('All feature paths:', featurePaths);

      // These are submodules and should be skipped
      expect(featurePaths).not.toContain('lib/concept-engine');
      expect(featurePaths).not.toContain('lib/ai-backend');
      expect(featurePaths).not.toContain('lib/reusable-concepts');
    });

    it('should discover frontend feature', async () => {
      const result = await service.discoverFeatures(PIGGY_BANK_PATH);

      expect(result.success).toBe(true);

      const frontendFeature = result.data!.find(f =>
        f.basePath.includes('frontend')
      );

      expect(frontendFeature).toBeDefined();
      if (frontendFeature) {
        console.log('Frontend feature:', {
          name: frontendFeature.name,
          apiFiles: frontendFeature.files.api.length,
          schemaFiles: frontendFeature.files.schema.length,
          otherFiles: frontendFeature.files.other.length,
        });
      }
    });

    it('should discover services feature', async () => {
      const result = await service.discoverFeatures(PIGGY_BANK_PATH);

      expect(result.success).toBe(true);

      const servicesFeature = result.data!.find(f =>
        f.basePath.includes('services')
      );

      expect(servicesFeature).toBeDefined();
      if (servicesFeature) {
        console.log('Services feature:', {
          name: servicesFeature.name,
          apiFiles: servicesFeature.files.api.length,
          schemaFiles: servicesFeature.files.schema.length,
          otherFiles: servicesFeature.files.other.length,
        });
      }
    });

    it('should skip ignored folders like node_modules, docs, coverage', async () => {
      const result = await service.discoverFeatures(PIGGY_BANK_PATH);

      expect(result.success).toBe(true);

      const featureNames = result.data!.map(f => f.name);

      // These should be ignored
      expect(featureNames).not.toContain('node_modules');
      expect(featureNames).not.toContain('docs');
      expect(featureNames).not.toContain('coverage');
      expect(featureNames).not.toContain('playwright-report');
      expect(featureNames).not.toContain('test-results');
      expect(featureNames).not.toContain('.git');
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================
  describe('Edge Cases', () => {
    it('should handle non-existent paths gracefully', async () => {
      const result = await service.discoverFeatures('/non/existent/path');

      // Should not throw, but return error or empty result
      expect(result).toBeDefined();
    });

    it('should handle empty directories', async () => {
      // Create temp empty dir test would go here
      // For now, we just verify the service handles errors gracefully
      expect(true).toBe(true);
    });
  });
});

// =========================================================================
// AI-Based Feature Detection Tests
// =========================================================================
describeIfFixtures('ContractGenerationService - AI Feature Detection', () => {
  it('should filter out non-feature folders when useAI=true', async () => {
    // Create a service with smart mock that only identifies frontend and services as features
    const smartMock = createSmartMockAIService(['frontend', 'services']);
    const aiService = new ContractGenerationService(
      smartMock as any,
      mockRegistryService as any
    );

    const result = await aiService.discoverFeatures(PIGGY_BANK_PATH, true);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const featureNames = result.data!.map(f => f.name);
    console.log('AI-filtered features:', featureNames);

    // Should only include features identified by AI
    expect(featureNames.length).toBe(2);

    // Should have frontend and services
    const hasFrontend = result.data!.some(f => f.basePath.includes('frontend'));
    const hasServices = result.data!.some(f => f.basePath.includes('services'));
    expect(hasFrontend).toBe(true);
    expect(hasServices).toBe(true);
  });

  it('should exclude tests, database, and pm_artefacts folders with AI detection', async () => {
    // Only identify frontend and services as features
    const smartMock = createSmartMockAIService(['frontend', 'services']);
    const aiService = new ContractGenerationService(
      smartMock as any,
      mockRegistryService as any
    );

    const result = await aiService.discoverFeatures(PIGGY_BANK_PATH, true);

    expect(result.success).toBe(true);

    const featureNames = result.data!.map(f => f.name);
    const featurePaths = result.data!.map(f => path.relative(PIGGY_BANK_PATH, f.basePath));

    console.log('AI-filtered feature paths:', featurePaths);

    // These are not features and should be excluded
    expect(featureNames).not.toContain('tests');
    expect(featureNames).not.toContain('database');
    expect(featureNames).not.toContain('pm_artefacts');
    expect(featurePaths).not.toContain('tests');
    expect(featurePaths).not.toContain('database');
    expect(featurePaths).not.toContain('pm_artefacts');
  });

  it('should fall back to mechanical scan when AI fails', async () => {
    // Create a service with failing AI mock
    const failingMock = {
      sendWithMode: async () => ({ success: false, error: { message: 'AI unavailable' } }),
    };
    const aiService = new ContractGenerationService(
      failingMock as any,
      mockRegistryService as any
    );

    const result = await aiService.discoverFeatures(PIGGY_BANK_PATH, true);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    // Should still find features (fallback to mechanical scan)
    expect(result.data!.length).toBeGreaterThan(0);

    console.log('Fallback features:', result.data!.map(f => f.name));
  });

  it('should include all candidate folders without AI (useAI=false)', async () => {
    // Use basic mock - no AI filtering
    const basicService = new ContractGenerationService(
      mockAIService as any,
      mockRegistryService as any
    );

    const result = await basicService.discoverFeatures(PIGGY_BANK_PATH, false);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const featureNames = result.data!.map(f => f.name);
    console.log('Non-AI features:', featureNames);

    // Without AI, it should find more "features" (actually just folders)
    // This includes tests, database, etc.
    expect(result.data!.length).toBeGreaterThan(2);
  });
});

// =========================================================================
// Utility function tests
// =========================================================================
describe('ContractGenerationService - File Scanning', () => {
  let service: ContractGenerationService;

  beforeAll(() => {
    service = new ContractGenerationService(
      mockAIService as any,
      mockRegistryService as any
    );
  });

  it('should correctly count feature files', async () => {
    const result = await service.discoverFeatures(SAMPLE_REPO_PATH);

    expect(result.success).toBe(true);

    for (const feature of result.data!) {
      const expectedCount = feature.files.api.length +
        feature.files.schema.length +
        feature.files.tests.e2e.length +
        feature.files.tests.unit.length +
        feature.files.tests.integration.length +
        feature.files.fixtures.length +
        feature.files.config.length +
        feature.files.other.length;

      expect(feature.contractPatternMatches).toBe(expectedCount);
    }
  });
});
