/**
 * Contract Generation Integration Test - LinkedIn Repo
 *
 * This test validates the contract generation prompts against the LinkedIn-New-Summary repo
 * and compares the results with expected contract types.
 *
 * Test Coverage:
 * - Feature discovery accuracy
 * - API endpoint detection
 * - Database schema detection
 * - Third-party integration detection
 * - Infrastructure/env var detection
 * - Event/message detection
 */

import { ContractGenerationService } from '../../../electron/services/ContractGenerationService';
import { AIService } from '../../../electron/services/AIService';
import * as fs from 'fs';
import * as path from 'path';

// LinkedIn repo path
const LINKEDIN_REPO = '/Volumes/Simba User Data/Development/Linkedin-New-Summary';

// This suite validates contract detection against a specific, machine-local
// external repo (not committed) and asserts its exact contents. It's an opt-in
// integration check, not a unit test of this app: run it explicitly with
// RUN_LINKEDIN_INTEGRATION=1 and the repo present. Otherwise skip so the default
// suite signal stays meaningful.
const runLinkedInSuite =
  process.env.RUN_LINKEDIN_INTEGRATION === '1' && fs.existsSync(LINKEDIN_REPO);
const describeLinkedIn = runLinkedInSuite ? describe : describe.skip;

// Expected features based on Kanvas feature discovery logic
// Uses IGNORE_FOLDERS, gitignore patterns, and git submodule filtering
// This list reflects what should be discovered after proper filtering
const EXPECTED_FEATURES = [
  // Services
  { name: 'backend', path: 'backend', hasAPI: true, hasDB: true, type: 'service' },
  { name: 'ai-worker', path: 'ai-worker', hasAPI: false, hasDB: false, type: 'service' },
  { name: 'firebase', path: 'firebase', hasAPI: true, hasDB: true, type: 'service' },
  { name: 'firebase-backups', path: 'firebase-backups', hasAPI: false, hasDB: false, type: 'service' },
  { name: 'firebase-data', path: 'firebase-data', hasAPI: false, hasDB: false, type: 'service' },
  { name: 'ScriptCS_DevOpsAgent', path: 'ScriptCS_DevOpsAgent', hasAPI: false, hasDB: false, type: 'service' },
  // Applications
  { name: 'web-app', path: 'web-app', hasAPI: false, hasDB: false, type: 'app' },
  { name: 'extension', path: 'extension', hasAPI: false, hasDB: false, type: 'app' },
  // Packages
  { name: 'packages', path: 'packages', hasAPI: false, hasDB: false, type: 'package' },
  // Other (project components)
  { name: 'House_Rules_Contracts', path: 'House_Rules_Contracts', hasAPI: false, hasDB: false, type: 'other' },
  { name: 'backups', path: 'backups', hasAPI: false, hasDB: false, type: 'other' },
  { name: 'deploy_test', path: 'deploy_test', hasAPI: false, hasDB: false, type: 'other' },
  { name: 'local_deploy', path: 'local_deploy', hasAPI: false, hasDB: false, type: 'other' },
  { name: 'pm_artefacts', path: 'pm_artefacts', hasAPI: false, hasDB: false, type: 'other' },
  { name: 'product_requirement_docs', path: 'product_requirement_docs', hasAPI: false, hasDB: false, type: 'other' },
  { name: 'product_requirements_docs', path: 'product_requirements_docs', hasAPI: false, hasDB: false, type: 'other' },
  { name: 'pulse-ai-config', path: 'pulse-ai-config', hasAPI: false, hasDB: false, type: 'other' },
  { name: 'src', path: 'src', hasAPI: false, hasDB: false, type: 'other' },
  { name: 'submodules', path: 'submodules', hasAPI: false, hasDB: false, type: 'other' },
];

// Folders that should be IGNORED (matching Kanvas IGNORE_FOLDERS)
const IGNORED_FOLDERS = [
  'tests', 'test', '__tests__', 'test-results', 'playwright-report', 'coverage',
  'node_modules', 'dist', 'build', 'out',
  'docs', 'Documentation', 'doc',
  'deploy', 'infra', 'infrastructure', 'scripts',
];

// Expected third-party integrations
const EXPECTED_INTEGRATIONS = [
  'Firebase',
  'Firestore',
  'OpenAI',
  'Google Cloud',
  'LinkedIn API',
];

// Expected env vars (from existing INFRA_CONTRACT.md)
const EXPECTED_ENV_VARS = [
  'FIREBASE_PROJECT_ID',
  'OPENAI_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
];

describeLinkedIn('Contract Generation - LinkedIn Repo', () => {
  let contractService: ContractGenerationService;
  let mockAIService: AIService;

  beforeAll(() => {
    // Skip if LinkedIn repo doesn't exist
    if (!fs.existsSync(LINKEDIN_REPO)) {
      console.log('LinkedIn repo not found, skipping tests');
      return;
    }
  });

  describe('Feature Discovery', () => {
    it('should discover features using Kanvas-compatible filtering', async () => {
      if (!fs.existsSync(LINKEDIN_REPO)) {
        console.log('Skipping - LinkedIn repo not found');
        return;
      }

      // Simulate Kanvas feature discovery logic
      const discoveredDirs = fs.readdirSync(LINKEDIN_REPO)
        .filter(f => {
          const fullPath = path.join(LINKEDIN_REPO, f);
          if (!fs.statSync(fullPath).isDirectory()) return false;
          if (f.startsWith('.')) return false;
          // Skip IGNORED_FOLDERS (same as Kanvas IGNORE_FOLDERS)
          if (IGNORED_FOLDERS.includes(f)) {
            console.log(`Filtering out ignored folder: ${f}`);
            return false;
          }
          return true;
        });

      console.log(`Discovered ${discoveredDirs.length} directories after filtering`);
      console.log('Discovered features:', discoveredDirs);

      // Should find approximately 19-20 features after filtering
      expect(discoveredDirs.length).toBeGreaterThanOrEqual(15);
      expect(discoveredDirs.length).toBeLessThanOrEqual(25);

      // Check core features are present
      const coreFeatures = ['backend', 'firebase', 'ai-worker', 'web-app', 'extension', 'packages'];
      for (const feature of coreFeatures) {
        const found = discoveredDirs.includes(feature);
        console.log(`Core feature ${feature}: ${found ? '✓ Found' : '✗ Missing'}`);
        expect(found).toBe(true);
      }

      // Verify ignored folders are NOT present
      for (const ignored of IGNORED_FOLDERS) {
        const found = discoveredDirs.includes(ignored);
        if (found) {
          console.log(`ERROR: Ignored folder ${ignored} should not be in results`);
        }
        expect(found).toBe(false);
      }
    });

    it('should identify backend as having API endpoints', async () => {
      if (!fs.existsSync(LINKEDIN_REPO)) return;

      const backendPath = path.join(LINKEDIN_REPO, 'backend');
      const srcPath = path.join(backendPath, 'src');

      // Look for route files - check the routes directory directly
      const findRoutes = (dir: string): string[] => {
        const routes: string[] = [];
        if (!fs.existsSync(dir)) return routes;

        const items = fs.readdirSync(dir);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            // Check if this is a routes, controllers, or api directory
            if (item === 'routes' || item === 'controllers' || item === 'api') {
              // Add all .ts files in this directory
              const files = fs.readdirSync(fullPath);
              for (const file of files) {
                if (file.endsWith('.ts') || file.endsWith('.js')) {
                  routes.push(path.join(fullPath, file));
                }
              }
            }
            routes.push(...findRoutes(fullPath));
          }
        }
        return routes;
      };

      const routeFiles = findRoutes(srcPath);
      console.log('Found route/API files:', routeFiles.length);
      if (routeFiles.length > 0) {
        console.log('Sample routes:', routeFiles.slice(0, 5));
      }
      expect(routeFiles.length).toBeGreaterThan(0);
    });

    it('should identify database operations in backend', async () => {
      if (!fs.existsSync(LINKEDIN_REPO)) return;

      const backendPath = path.join(LINKEDIN_REPO, 'backend');

      // Look for database-related files
      const findDbFiles = (dir: string): string[] => {
        const dbFiles: string[] = [];
        if (!fs.existsSync(dir)) return dbFiles;

        const items = fs.readdirSync(dir);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory() && !item.includes('node_modules')) {
            dbFiles.push(...findDbFiles(fullPath));
          } else if (
            item.includes('model') ||
            item.includes('schema') ||
            item.includes('migration') ||
            item.includes('repository') ||
            item.includes('prisma') ||
            item.includes('firestore')
          ) {
            dbFiles.push(fullPath);
          }
        }
        return dbFiles;
      };

      const dbFiles = findDbFiles(backendPath);
      console.log('Found database-related files:', dbFiles.length);
      expect(dbFiles.length).toBeGreaterThan(0);
    });
  });

  describe('Third Party Integration Detection', () => {
    it('should detect Firebase integration', async () => {
      if (!fs.existsSync(LINKEDIN_REPO)) return;

      // Check multiple package.json files for firebase (firebase is in firebase/functions/package.json)
      const checkPackageForDep = (pkgPath: string, depPattern: string): boolean => {
        if (!fs.existsSync(pkgPath)) return false;
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          return Object.keys(deps).some(d => d.toLowerCase().includes(depPattern.toLowerCase()));
        } catch {
          return false;
        }
      };

      const packagePaths = [
        path.join(LINKEDIN_REPO, 'package.json'),
        path.join(LINKEDIN_REPO, 'firebase', 'package.json'),
        path.join(LINKEDIN_REPO, 'firebase', 'functions', 'package.json'),
        path.join(LINKEDIN_REPO, 'backend', 'package.json'),
      ];

      let hasFirebase = false;
      for (const pkgPath of packagePaths) {
        if (checkPackageForDep(pkgPath, 'firebase')) {
          console.log(`Firebase detected in: ${pkgPath}`);
          hasFirebase = true;
          break;
        }
      }
      expect(hasFirebase).toBe(true);
    });

    it('should detect OpenAI integration', async () => {
      if (!fs.existsSync(LINKEDIN_REPO)) return;

      // Check for OpenAI in multiple package.json files
      const checkForOpenAI = (dir: string): boolean => {
        const pkgPath = path.join(dir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          return Object.keys(deps).some(d => d.toLowerCase().includes('openai'));
        } catch {
          return false;
        }
      };

      const dirsToCheck = [
        'backend',
        'ai-worker',
        'firebase',
        'firebase/functions',
      ];

      let foundOpenAI = false;
      for (const dir of dirsToCheck) {
        const fullPath = path.join(LINKEDIN_REPO, dir);
        if (checkForOpenAI(fullPath)) {
          console.log(`OpenAI found in ${dir}`);
          foundOpenAI = true;
          break;
        }
      }

      expect(foundOpenAI).toBe(true);
    });
  });

  describe('Environment Variable Detection', () => {
    it('should detect env vars from .env.example', async () => {
      if (!fs.existsSync(LINKEDIN_REPO)) return;

      const envExamplePath = path.join(LINKEDIN_REPO, '.env.example');
      if (!fs.existsSync(envExamplePath)) {
        console.log('.env.example not found');
        return;
      }

      const envContent = fs.readFileSync(envExamplePath, 'utf-8');
      const envVars = envContent
        .split('\n')
        .filter(line => line.includes('=') && !line.startsWith('#'))
        .map(line => line.split('=')[0].trim());

      console.log('Found env vars:', envVars.length);
      console.log('Sample vars:', envVars.slice(0, 10));

      expect(envVars.length).toBeGreaterThan(0);
    });

    it('should detect env var usage in code', async () => {
      if (!fs.existsSync(LINKEDIN_REPO)) return;

      const backendPath = path.join(LINKEDIN_REPO, 'backend', 'src');
      if (!fs.existsSync(backendPath)) return;

      // Grep for process.env usage
      const findEnvUsage = (dir: string): string[] => {
        const envVars: Set<string> = new Set();
        if (!fs.existsSync(dir)) return [];

        const processDir = (d: string) => {
          const items = fs.readdirSync(d);
          for (const item of items) {
            const fullPath = path.join(d, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory() && !item.includes('node_modules')) {
              processDir(fullPath);
            } else if (item.endsWith('.ts') || item.endsWith('.js')) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const matches = content.matchAll(/process\.env\.(\w+)/g);
                for (const match of matches) {
                  envVars.add(match[1]);
                }
              } catch (e) {
                // Skip unreadable files
              }
            }
          }
        };

        processDir(dir);
        return Array.from(envVars);
      };

      const usedEnvVars = findEnvUsage(backendPath);
      console.log('Env vars used in code:', usedEnvVars.length);
      console.log('Sample:', usedEnvVars.slice(0, 10));

      expect(usedEnvVars.length).toBeGreaterThan(0);
    });
  });

  describe('Contract Comparison Report', () => {
    it('should generate comparison report with Kanvas-compatible features', async () => {
      if (!fs.existsSync(LINKEDIN_REPO)) return;

      // Apply Kanvas-compatible filtering
      const filteredDirs = fs.readdirSync(LINKEDIN_REPO).filter(f => {
        const fullPath = path.join(LINKEDIN_REPO, f);
        if (!fs.statSync(fullPath).isDirectory()) return false;
        if (f.startsWith('.')) return false;
        if (IGNORED_FOLDERS.includes(f)) return false;
        return true;
      });

      const report = {
        timestamp: new Date().toISOString(),
        repo: LINKEDIN_REPO,
        features: {
          expected: EXPECTED_FEATURES.length,
          discovered: filteredDirs.length,
          details: filteredDirs.map(d => ({
            name: d,
            path: path.join(LINKEDIN_REPO, d),
            hasPackageJson: fs.existsSync(path.join(LINKEDIN_REPO, d, 'package.json')),
            type: inferFeatureType(d),
          })),
        },
        api: {
          routeFilesFound: 0,
          endpoints: [] as string[],
        },
        database: {
          schemaFilesFound: 0,
          tables: [] as string[],
        },
        thirdParty: {
          expected: EXPECTED_INTEGRATIONS,
          found: [] as string[],
        },
        infrastructure: {
          envVarsInExample: 0,
          envVarsInCode: 0,
        },
      };

      // Helper to infer feature type
      function inferFeatureType(name: string): string {
        const lcName = name.toLowerCase();
        if (lcName.includes('backend') || lcName.includes('worker') || lcName.includes('firebase') || lcName.includes('server') || lcName.includes('api')) {
          return 'service';
        }
        if (lcName.includes('web') || lcName.includes('extension') || lcName.includes('app')) {
          return 'app';
        }
        if (lcName.includes('package') || lcName.includes('lib') || lcName.includes('shared')) {
          return 'package';
        }
        return 'other';
      }

      // Check for integrations in root package.json
      const rootPkg = JSON.parse(fs.readFileSync(path.join(LINKEDIN_REPO, 'package.json'), 'utf-8'));
      const allDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };

      for (const integration of EXPECTED_INTEGRATIONS) {
        const found = Object.keys(allDeps).some(d =>
          d.toLowerCase().includes(integration.toLowerCase())
        );
        if (found) {
          report.thirdParty.found.push(integration);
        }
      }

      console.log('\n========== CONTRACT COMPARISON REPORT ==========');
      console.log(`Features discovered: ${report.features.discovered} (expected: ~${report.features.expected})`);
      console.log('\nFeature List:');
      for (const f of report.features.details) {
        console.log(`  - ${f.name} (${f.type}) ${f.hasPackageJson ? '📦' : ''}`);
      }
      console.log('================================================\n');

      // Write report to file
      const reportPath = path.join(
        '/Volumes/Simba User Data/Development/SecondBrain_Code_Studio/DevOpsAgent/local_deploy',
        'linkedin-contract-test-report.json'
      );
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`Report saved to: ${reportPath}`);

      // Assertions
      expect(report.features.discovered).toBeGreaterThanOrEqual(15);
      expect(report.features.discovered).toBeLessThanOrEqual(25);
    });
  });
});
