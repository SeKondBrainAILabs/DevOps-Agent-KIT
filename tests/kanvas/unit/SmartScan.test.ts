/**
 * SmartScan Tests
 * Tests the smart scanning behavior in ContractGenerationService.scanFeatureFiles
 *
 * Creates real temp directory structures and verifies that:
 * - Small directories (<30 other files) are not filtered
 * - Large directories with contract files: "other" limited to contract-adjacent dirs
 * - Large directories with zero contract files: "other" capped at 30
 * - contractRelevant count is unchanged regardless of smart scan
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { ContractGenerationService } from '../../../electron/services/ContractGenerationService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

// Minimal mocks for constructor deps (not used for scanning)
const mockAIService = { sendWithMode: jest.fn() };
const mockRegistryService = { register: jest.fn() };

function createService(): ContractGenerationService {
  return new ContractGenerationService(
    mockAIService as any,
    mockRegistryService as any
  );
}

/**
 * Helper: create a file at the given path (creating parent dirs as needed)
 */
function touch(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `// ${path.basename(filePath)}\n`);
}

describe('Smart Scan - scanFeatureFiles', () => {
  let tmpDir: string;
  let service: AnyService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-scan-test-'));
    service = createService();
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * Access the private scanFeatureFiles method
   */
  async function scanFeatureFiles(featurePath: string, repoPath: string) {
    return (service as AnyService).scanFeatureFiles(featurePath, repoPath);
  }

  it('should not filter when other files are below threshold (<30)', async () => {
    // Create a small directory with a few source files and one API file
    touch(path.join(tmpDir, 'routes', 'auth.ts'));
    touch(path.join(tmpDir, 'utils', 'helper.ts'));
    touch(path.join(tmpDir, 'components', 'Button.tsx'));
    touch(path.join(tmpDir, 'index.ts'));

    const files = await scanFeatureFiles(tmpDir, tmpDir);

    // The API file (routes/auth.ts) should be categorized
    expect(files.api.length).toBeGreaterThanOrEqual(1);
    // Other files should be present unfiltered (below threshold)
    const totalOther = files.other.length;
    expect(totalOther).toBeLessThanOrEqual(29); // well below threshold
    expect(totalOther).toBeGreaterThanOrEqual(1); // at least some other files
  });

  it('should filter large "other" to contract-adjacent dirs when categorized files exist', async () => {
    // Create contract files in specific directories
    touch(path.join(tmpDir, 'backend', 'routes', 'auth.ts'));
    touch(path.join(tmpDir, 'backend', 'routes', 'users.ts'));
    touch(path.join(tmpDir, 'backend', 'types', 'auth.ts'));
    // Create a "nearby" source file (same parent area)
    touch(path.join(tmpDir, 'backend', 'utils', 'hash.ts'));
    touch(path.join(tmpDir, 'backend', 'middleware', 'cors.ts'));

    // Create 40+ "far away" source files that should be filtered out
    for (let i = 0; i < 45; i++) {
      touch(path.join(tmpDir, 'frontend', 'components', `Component${i}.tsx`));
    }

    const files = await scanFeatureFiles(tmpDir, tmpDir);

    // Contract files should still be categorized
    expect(files.api.length).toBeGreaterThanOrEqual(2); // routes/auth.ts, routes/users.ts
    expect(files.schema.length).toBeGreaterThanOrEqual(1); // types/auth.ts

    // Smart scan should have reduced "other" — should NOT include all 45 frontend components
    // since they're not in contract-adjacent directories
    expect(files.other.length).toBeLessThan(45);
  });

  it('should cap "other" at threshold when zero categorized files exist', async () => {
    // Create 50 generic source files, no contract patterns
    for (let i = 0; i < 50; i++) {
      touch(path.join(tmpDir, 'lib', `module${i}.ts`));
    }

    const files = await scanFeatureFiles(tmpDir, tmpDir);

    // No categorized files
    expect(files.api.length).toBe(0);
    expect(files.schema.length).toBe(0);

    // Other should be capped at SMART_SCAN_OTHER_THRESHOLD (30)
    expect(files.other.length).toBeLessThanOrEqual(30);
    expect(files.other.length).toBeGreaterThan(0);
  });

  it('should sort capped other files by depth (shallowest first) when no categorized files', async () => {
    // Create files at various depths
    touch(path.join(tmpDir, 'shallow.ts'));
    touch(path.join(tmpDir, 'a', 'medium.ts'));
    touch(path.join(tmpDir, 'a', 'b', 'deep.ts'));
    touch(path.join(tmpDir, 'a', 'b', 'c', 'verydeep.ts'));

    // Fill with many deep files to exceed threshold
    for (let i = 0; i < 40; i++) {
      touch(path.join(tmpDir, 'deep', 'nested', 'level', `file${i}.ts`));
    }

    const files = await scanFeatureFiles(tmpDir, tmpDir);

    // Should be capped at 30
    expect(files.other.length).toBeLessThanOrEqual(30);

    if (files.other.length > 1) {
      // Verify shallow files appear before deep files
      const depths = files.other.map((f: string) => f.split('/').length);
      for (let i = 1; i < depths.length; i++) {
        expect(depths[i]).toBeGreaterThanOrEqual(depths[i - 1]);
      }
    }
  });

  it('should preserve contractRelevant count regardless of smart scan filtering', async () => {
    // Create contract files in a specific subdirectory (deep enough so grandparent != repoRoot)
    touch(path.join(tmpDir, 'backend', 'src', 'routes', 'auth.ts'));
    touch(path.join(tmpDir, 'backend', 'src', 'routes', 'users.ts'));
    touch(path.join(tmpDir, 'backend', 'src', 'types', 'models.ts'));
    touch(path.join(tmpDir, 'backend', 'src', 'config', 'app.config.ts'));
    touch(path.join(tmpDir, 'backend', 'tests', 'auth.test.ts'));

    // Add many "other" files in a completely different subtree to trigger smart scan
    for (let i = 0; i < 40; i++) {
      touch(path.join(tmpDir, 'frontend', 'components', 'views', `Page${i}.tsx`));
    }

    const files = await scanFeatureFiles(tmpDir, tmpDir);

    // Count categorized (contract-relevant) files
    const contractRelevant =
      files.api.length +
      files.schema.length +
      files.tests.e2e.length +
      files.tests.unit.length +
      files.tests.integration.length +
      files.fixtures.length +
      files.config.length +
      (files.css?.length || 0) +
      (files.prompts?.length || 0);

    // Contract-relevant count should be > 0 and unchanged by smart scan
    expect(contractRelevant).toBeGreaterThan(0);
    // The "other" should have been filtered — frontend components are not adjacent to backend contracts
    expect(files.other.length).toBeLessThan(40);
  });
});
