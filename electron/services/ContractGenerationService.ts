/**
 * Contract Generation Service
 * Scans codebases feature-by-feature and generates contract documentation using AI
 * Outputs both Markdown and JSON formats to feature folders and central registry
 */

import { BaseService } from './BaseService';
import type {
  IpcResult,
  DiscoveredFeature,
  ContractGenerationOptions,
  ContractGenerationProgress,
  GeneratedContractResult,
  BatchContractGenerationResult,
  GeneratedContractJSON,
} from '../../shared/types';
import { IPC } from '../../shared/ipc-channels';
import { promises as fs } from 'fs';
import path from 'path';
import type { AIService } from './AIService';

// Helper to get globSync via dynamic import (glob v11 is ESM-only)
let _globSync: ((pattern: string, options?: object) => string[]) | null = null;
async function getGlobSync() {
  if (!_globSync) {
    const glob = await import('glob');
    // Handle both glob v11 (named export) and v7/v8/v9 or CommonJS interop (default export with sync method)
    // @ts-ignore - Dynamic import handling
    _globSync = glob.globSync || (glob.default && glob.default.sync) || glob.sync;
  }
  return _globSync;
}
import type { ContractRegistryService } from './ContractRegistryService';
import { databaseService } from './DatabaseService';
import { KANVAS_PATHS } from '../../shared/agent-protocol';
// Phase 3: Analysis services for enhanced contract generation
import type { ASTParserService } from './analysis/ASTParserService';
import type { APIExtractorService } from './analysis/APIExtractorService';
import type { SchemaExtractorService } from './analysis/SchemaExtractorService';
import type { DependencyGraphService } from './analysis/DependencyGraphService';
import type { ParsedAST, ExtractedEndpoint, ExtractedSchema, DependencyGraph } from '../../shared/analysis-types';

// Repository structure analysis result
interface RepoStructureAnalysis {
  applicationType: string;
  techStack: {
    languages: string[];
    frameworks: string[];
    databases: string[];
    keyDependencies: string[];
  };
  architecturePattern: string;
  entryPoints: Array<{ file: string; description: string }>;
  features: Array<{ name: string; path: string; description: string }>;
  externalIntegrations: Array<{ name: string; type: string; purpose: string }>;
}

// Feature analysis result with APIs exposed/consumed
interface FeatureAnalysis {
  feature: string;
  purpose: string;
  apisExposed: {
    httpEndpoints: Array<{
      method: string;
      path: string;
      handler: string;
      file: string;
      line?: number;
      parameters?: Array<{ name: string; type: string; in: string; required: boolean }>;
      responseType?: string;
      authentication?: string;
      description?: string;
    }>;
    exportedFunctions: Array<{
      name: string;
      file: string;
      line?: number;
      signature?: string;
      description?: string;
      isAsync?: boolean;
    }>;
    exportedTypes: Array<{
      name: string;
      kind: string;
      file: string;
      line?: number;
      properties?: Array<{ name: string; type: string; optional: boolean }>;
    }>;
    eventsEmitted: Array<{
      eventName: string;
      payload?: string;
      emittedFrom?: string;
    }>;
  };
  apisConsumed: {
    httpCalls: Array<{
      method: string;
      url: string;
      purpose?: string;
      calledFrom?: string;
    }>;
    internalImports: Array<{
      from: string;
      imports: string[];
      usedIn?: string;
    }>;
    externalPackages: Array<{
      package: string;
      imports: string[];
      purpose?: string;
    }>;
    databaseOperations: Array<{
      type: string;
      table?: string;
      file: string;
      line?: number;
    }>;
    eventsConsumed: Array<{
      eventName: string;
      handler?: string;
      file?: string;
    }>;
  };
  dataModels: Array<{
    name: string;
    type: string;
    file: string;
    fields?: Array<{ name: string; type: string; constraints?: string }>;
  }>;
  dependencies: {
    internal: string[];
    external: string[];
  };
}

// Contract file patterns - reused from ContractDetectionService
const CONTRACT_PATTERNS = {
  // API files
  api: [
    '**/openapi.yaml', '**/openapi.json', '**/swagger.yaml', '**/swagger.json',
    '**/*.graphql', '**/schema.graphql', '**/schema.gql',
    '**/*.proto',
    '**/routes/**/*.ts', '**/api/**/*.ts', '**/controllers/**/*.ts',
    '**/endpoints/**/*.ts', '**/handlers/**/*.ts',
    '**/routes/**/*.js', '**/api/**/*.js', '**/controllers/**/*.js',
  ],
  // Schema/Type files
  schema: [
    '**/types/*.ts', '**/interfaces/*.ts', '**/*.d.ts',
    '**/shared/types.ts', '**/shared/types/*.ts',
    '**/migrations/*.sql', '**/schema.prisma', '**/schema.sql',
    '**/*.schema.json', '**/schemas/*.json',
    '**/models/**/*.ts', '**/entities/**/*.ts',
  ],
  // E2E Tests
  e2e: [
    '**/*.e2e.spec.ts', '**/*.e2e.ts', '**/*.e2e.test.ts',
    '**/e2e/**/*.spec.ts', '**/playwright/**/*.spec.ts',
    '**/tests/e2e/**/*.ts', '**/tests/e2e/**/*.js',
    '**/*.api.spec.ts', '**/*.e2e.spec.js',
  ],
  // Unit Tests
  unit: [
    '**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts',
    '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx',
    '**/*.test.js', '**/*.test.jsx', '**/*.spec.js',
    '**/__tests__/**/*.js', '**/__tests__/**/*.jsx',
  ],
  // Integration Tests
  integration: [
    '**/*.integration.ts', '**/*.integration.spec.ts',
    '**/tests/integration/**/*.ts', '**/tests/integration/**/*.js',
    '**/*.integration.test.ts', '**/*.integration.test.js',
  ],
  // Fixtures
  fixtures: [
    '**/fixtures/**/*.json', '**/fixtures/**/*.ts', '**/fixtures/**/*.js',
    '**/mocks/**/*.ts', '**/__mocks__/**/*.ts',
    '**/mocks/**/*.js', '**/__mocks__/**/*.js',
    '**/test-data/**/*.json', '**/seed/**/*.ts', '**/seed/**/*.js',
    '**/factories/**/*.ts', '**/factories/**/*.js',
  ],
  // Config
  config: [
    '**/.env.example', '**/config.schema.json', '**/app.config.ts',
    '**/config/*.ts', '**/config/*.json', '**/config/*.yaml', '**/config/*.yml',
    '**/docker-compose.yml', '**/docker-compose.yaml',
    '**/Dockerfile', '**/Makefile', '**/Taskfile.yml',
  ],
  // CSS/Style files
  css: [
    '**/*.css', '**/*.scss', '**/*.less', '**/*.styl',
    '**/tailwind.config.*', '**/.stylelintrc*',
    '**/*theme*.*', '**/*style*.*',
  ],
  // Prompt/Skill/Mode configuration files
  prompts: [
    '**/*prompt*.*', '**/*skill*.*',
    '**/modes/*.yaml', '**/modes/*.yml',
    '**/prompts/**/*.yaml', '**/prompts/**/*.yml',
    '**/prompts/**/*.ts', '**/prompts/**/*.json',
  ],
};

// Generic source file patterns to identify code areas (for feature discovery)
const SOURCE_PATTERNS = [
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
  '**/*.py', '**/*.go', '**/*.rs', '**/*.java',
  '**/*.vue', '**/*.svelte',
];

// Feature folder patterns to scan (ordered by specificity)
const FEATURE_FOLDER_PATTERNS = [
  // Standard nested patterns
  'src/features/*',
  'src/modules/*',
  'packages/*',
  'apps/*',
  'lib/*',
  'services/*',
  // Service-level patterns (deeper scanning for routes, services, handlers)
  'backend/src/routes',
  'backend/src/services',
  'backend/src/handlers',
  'backend/src/controllers',
  'backend/src/modules/*',
  'backend/src/features/*',
  'backend/routes',
  'backend/services',
  'server/src/routes',
  'server/src/services',
  'api/src/routes',
  'api/src/services',
  // AI worker patterns
  'ai-worker/src/handlers',
  'ai-worker/src/services',
  'ai-worker/src/processors',
  'workers/*/src',
  // Common top-level structures
  'backend',
  'frontend',
  'server',
  'client',
  'api',
  'web',
  'mobile',
  'extension',
  'firebase',
  'functions',
  'lambdas',
  'workers',
  'ai-worker',
  'devops',
  // Any top-level folder with code (fallback)
  '*',
];

// Folders to always ignore when scanning for features
// Keep this minimal - most exclusions should come from .gitignore and .gitmodules
// User will manually label other items as submodules if needed
const IGNORE_FOLDERS = new Set([
  // Git internals
  '.git',
  // Test directories (never business features)
  'tests', 'test', '__tests__', 'test-results', 'playwright-report', 'coverage', '.nyc_output',
  // Build outputs (should also be in .gitignore, but commonly missed)
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.output',
  // Documentation (not software features)
  'docs', 'Documentation', 'doc',
  // Infrastructure/DevOps (not software features)
  'deploy', 'infra', 'infrastructure', 'scripts',
]);

/**
 * Parse .gitignore file and return patterns
 */
function parseGitignore(gitignoreContent: string): string[] {
  return gitignoreContent
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#')) // Remove empty lines and comments
    .map(pattern => {
      // Remove leading slash (gitignore uses it for root-relative paths)
      if (pattern.startsWith('/')) pattern = pattern.slice(1);
      // Remove trailing slash (directories)
      if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
      return pattern;
    });
}

/**
 * Check if a path matches any gitignore pattern
 */
function matchesGitignorePattern(relativePath: string, patterns: string[]): boolean {
  const pathParts = relativePath.split('/');
  
  for (const pattern of patterns) {
    // Exact match
    if (relativePath === pattern) return true;
    
    // Directory match (any part of path matches)
    if (pathParts.includes(pattern)) return true;
    
    // Wildcard patterns
    if (pattern.includes('*')) {
      const regexPattern = pattern
        .replace(/\./g, '\\.') // Escape dots
        .replace(/\*/g, '.*');  // Convert * to .*
      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(relativePath)) return true;
      // Also check if any path component matches
      if (pathParts.some(part => regex.test(part))) return true;
    }
  }
  
  return false;
}

// Metadata file for tracking contract generation state
const CONTRACT_GENERATION_METADATA_FILE = '.contract-generation-meta.json';

interface ContractGenerationMetadata {
  lastGeneratedAt: string; // ISO timestamp
  lastCommitHash: string;
  generatedFeatures: string[];
  version: string;
}

export class ContractGenerationService extends BaseService {
  private aiService: AIService;
  private registryService: ContractRegistryService;
  private isCancelled = false;
  private currentProgress: ContractGenerationProgress | null = null;

  // Phase 3: Analysis services for enhanced contract generation
  private astParser?: ASTParserService;
  private apiExtractor?: APIExtractorService;
  private schemaExtractor?: SchemaExtractorService;
  private dependencyGraph?: DependencyGraphService;

  constructor(aiService: AIService, registryService: ContractRegistryService) {
    super();
    this.aiService = aiService;
    this.registryService = registryService;
  }

  /**
   * Get contract generation metadata (last generation time, commit hash, etc.)
   */
  private async getGenerationMetadata(repoPath: string): Promise<ContractGenerationMetadata | null> {
    try {
      const metaPath = path.join(repoPath, KANVAS_PATHS.baseDir, CONTRACT_GENERATION_METADATA_FILE);
      const content = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Save contract generation metadata
   */
  private async saveGenerationMetadata(repoPath: string, metadata: ContractGenerationMetadata): Promise<void> {
    const metaPath = path.join(repoPath, KANVAS_PATHS.baseDir, CONTRACT_GENERATION_METADATA_FILE);
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  /**
   * Get current git commit hash
   */
  private async getCurrentCommitHash(repoPath: string): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      const hash = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
      return hash;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get files changed since a specific commit
   */
  private async getChangedFilesSinceCommit(repoPath: string, sinceCommit: string): Promise<string[]> {
    try {
      const { execSync } = await import('child_process');
      // Get files changed since the given commit
      const output = execSync(`git diff --name-only ${sinceCommit} HEAD`, { cwd: repoPath, encoding: 'utf-8' });
      return output.trim().split('\n').filter(f => f.length > 0);
    } catch {
      // If error (e.g., commit doesn't exist), return empty - will force full refresh
      return [];
    }
  }

  /**
   * Determine which features have changes based on git diffs
   */
  private getFeaturesWithChanges(features: DiscoveredFeature[], changedFiles: string[], repoPath: string): DiscoveredFeature[] {
    if (changedFiles.length === 0) {
      return []; // No changes, nothing to update
    }

    return features.filter(feature => {
      // Get relative path of feature base
      const featureRelPath = path.relative(repoPath, feature.basePath);

      // Check if any changed file is within this feature's directory
      return changedFiles.some(changedFile => {
        // Check if the changed file is in the feature directory
        if (changedFile.startsWith(featureRelPath + '/') || changedFile.startsWith(featureRelPath + '\\')) {
          return true;
        }
        // Also check if the feature references the changed file
        const allFeatureFiles = [
          ...feature.files.api,
          ...feature.files.schema,
          ...feature.files.tests.e2e,
          ...feature.files.tests.unit,
          ...feature.files.tests.integration,
          ...feature.files.fixtures,
          ...feature.files.config,
          ...(feature.files.css || []),
          ...(feature.files.prompts || []),
          ...feature.files.other,
        ];
        return allFeatureFiles.some(featureFile => {
          const relFile = path.relative(repoPath, featureFile);
          return relFile === changedFile;
        });
      });
    });
  }

  /**
   * Check if this is the first run (no existing contracts)
   */
  private async isFirstRun(repoPath: string): Promise<boolean> {
    // Check if metadata exists
    const metadata = await this.getGenerationMetadata(repoPath);
    if (!metadata) return true;

    // Check if contracts directory exists with any content
    const contractsDir = path.join(repoPath, 'House_Rules_Contracts');
    try {
      const files = await fs.readdir(contractsDir);
      return files.filter(f => f.endsWith('.md')).length === 0;
    } catch {
      return true;
    }
  }

  /**
   * Set analysis services for enhanced contract generation (Phase 3)
   */
  setAnalysisServices(
    astParser: ASTParserService,
    apiExtractor: APIExtractorService,
    schemaExtractor: SchemaExtractorService,
    dependencyGraph: DependencyGraphService
  ): void {
    this.astParser = astParser;
    this.apiExtractor = apiExtractor;
    this.schemaExtractor = schemaExtractor;
    this.dependencyGraph = dependencyGraph;
    console.log('[ContractGeneration] Analysis services configured for enhanced generation');
  }

  /**
   * PHASE 1: Analyze repository structure to understand the codebase
   * This should be called BEFORE discovering features
   */
  async analyzeRepoStructure(repoPath: string): Promise<IpcResult<RepoStructureAnalysis>> {
    return this.wrap(async () => {
      console.log(`[ContractGeneration] Analyzing repository structure: ${repoPath}`);

      // Get directory tree
      const directoryTree = await this.getDirectoryTree(repoPath, 3);

      // Check for key config files
      const hasPackageJson = await this.fileExists(path.join(repoPath, 'package.json'));
      const hasTsconfig = await this.fileExists(path.join(repoPath, 'tsconfig.json'));
      const hasDockerfile = await this.fileExists(path.join(repoPath, 'Dockerfile'));
      const hasDockerCompose = await this.fileExists(path.join(repoPath, 'docker-compose.yml')) ||
                               await this.fileExists(path.join(repoPath, 'docker-compose.yaml'));

      // Read package.json if exists
      let packageJsonContent = '';
      if (hasPackageJson) {
        try {
          const content = await fs.readFile(path.join(repoPath, 'package.json'), 'utf-8');
          const parsed = JSON.parse(content);
          // Only include relevant parts
          packageJsonContent = JSON.stringify({
            name: parsed.name,
            version: parsed.version,
            description: parsed.description,
            main: parsed.main,
            scripts: Object.keys(parsed.scripts || {}),
            dependencies: Object.keys(parsed.dependencies || {}),
            devDependencies: Object.keys(parsed.devDependencies || {}),
          }, null, 2);
        } catch {
          packageJsonContent = 'Failed to parse';
        }
      }

      // Use AI to analyze the structure
      const result = await this.aiService.sendWithMode({
        modeId: 'contract_generator',
        promptKey: 'analyze_repo_structure',
        variables: {
          repo_name: path.basename(repoPath),
          directory_tree: directoryTree,
          has_package_json: String(hasPackageJson),
          has_tsconfig: String(hasTsconfig),
          has_dockerfile: String(hasDockerfile),
          has_docker_compose: String(hasDockerCompose),
          package_json_content: packageJsonContent || 'Not present',
        },
      });

      if (!result.success || !result.data) {
        throw new Error(`Failed to analyze repo structure: ${result.error?.message}`);
      }

      // Parse the JSON response
      let analysis: RepoStructureAnalysis;
      try {
        let jsonStr = result.data.trim();
        // Remove markdown code fences if present
        if (jsonStr.includes('```json')) {
          jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        } else if (jsonStr.includes('```')) {
          jsonStr = jsonStr.replace(/```\n?/g, '');
        }
        analysis = JSON.parse(jsonStr);
      } catch {
        console.warn('[ContractGeneration] Failed to parse AI response, using defaults');
        analysis = {
          applicationType: 'Unknown',
          techStack: { languages: [], frameworks: [], databases: [], keyDependencies: [] },
          architecturePattern: 'Unknown',
          entryPoints: [],
          features: [],
          externalIntegrations: [],
        };
      }

      console.log(`[ContractGeneration] Repo analysis complete: ${analysis.applicationType}, ${analysis.features.length} features identified`);
      return analysis;
    }, 'ANALYZE_REPO_STRUCTURE_ERROR');
  }

  /**
   * PHASE 2: Generate README documentation for the repository
   */
  async generateRepoReadme(
    repoPath: string,
    structureAnalysis: RepoStructureAnalysis
  ): Promise<IpcResult<string>> {
    return this.wrap(async () => {
      console.log(`[ContractGeneration] Generating README for: ${repoPath}`);

      const directoryTree = await this.getDirectoryTree(repoPath, 3);

      const result = await this.aiService.sendWithMode({
        modeId: 'contract_generator',
        promptKey: 'generate_readme',
        variables: {
          repo_name: path.basename(repoPath),
          analysis_json: JSON.stringify(structureAnalysis, null, 2),
          directory_tree: directoryTree,
        },
      });

      if (!result.success || !result.data) {
        throw new Error(`Failed to generate README: ${result.error?.message}`);
      }

      // Save README to repo
      const readmePath = path.join(repoPath, 'ARCHITECTURE.md');
      await fs.writeFile(readmePath, result.data, 'utf-8');
      console.log(`[ContractGeneration] Saved architecture doc: ${readmePath}`);

      return result.data;
    }, 'GENERATE_README_ERROR');
  }

  /**
   * PHASE 3: Deep analysis of a feature - identifies APIs exposed and consumed
   */
  async analyzeFeatureDeep(
    repoPath: string,
    feature: DiscoveredFeature
  ): Promise<IpcResult<FeatureAnalysis>> {
    return this.wrap(async () => {
      console.log(`[ContractGeneration] Deep analyzing feature: ${feature.name}`);

      // Get file list
      const allFiles = [
        ...feature.files.api,
        ...feature.files.schema,
        ...feature.files.other.slice(0, 20), // Limit other files
      ];

      // Extract code samples from key files
      const codeSamples = await this.extractCodeSamplesDeep(repoPath, feature, 15);

      const result = await this.aiService.sendWithMode({
        modeId: 'contract_generator',
        promptKey: 'analyze_feature',
        variables: {
          feature_name: feature.name,
          feature_path: path.relative(repoPath, feature.basePath),
          repo_name: path.basename(repoPath),
          file_list: allFiles.join('\n'),
          code_samples: codeSamples,
        },
        userMessage: 'Analyze this feature and return ONLY valid JSON with the analysis structure. No explanations.',
      });

      if (!result.success || !result.data) {
        throw new Error(`Failed to analyze feature: ${result.error?.message}`);
      }

      // Parse the JSON response
      let analysis: FeatureAnalysis;
      try {
        let jsonStr = result.data.trim();
        // Remove markdown code fences if present
        if (jsonStr.includes('```json')) {
          jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        } else if (jsonStr.includes('```')) {
          jsonStr = jsonStr.replace(/```\n?/g, '');
        }
        // Try to extract JSON if there's text before/after
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
        analysis = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.warn(`[ContractGeneration] Failed to parse feature analysis for ${feature.name}:`, parseErr);
        console.warn(`[ContractGeneration] Raw response (first 500 chars): ${result.data.substring(0, 500)}`);
        analysis = this.createEmptyFeatureAnalysis(feature.name);
      }

      console.log(`[ContractGeneration] Feature ${feature.name}: ${analysis.apisExposed.httpEndpoints.length} endpoints exposed, ${analysis.apisConsumed.httpCalls.length} HTTP calls consumed`);
      return analysis;
    }, 'ANALYZE_FEATURE_DEEP_ERROR');
  }

  /**
   * Helper: Create empty feature analysis structure
   */
  private createEmptyFeatureAnalysis(featureName: string): FeatureAnalysis {
    return {
      feature: featureName,
      purpose: '',
      apisExposed: {
        httpEndpoints: [],
        exportedFunctions: [],
        exportedTypes: [],
        eventsEmitted: [],
      },
      apisConsumed: {
        httpCalls: [],
        internalImports: [],
        externalPackages: [],
        databaseOperations: [],
        eventsConsumed: [],
      },
      dataModels: [],
      dependencies: { internal: [], external: [] },
    };
  }

  /**
   * Helper: Get directory tree as string
   */
  private async getDirectoryTree(dirPath: string, maxDepth: number, currentDepth = 0, prefix = ''): Promise<string> {
    if (currentDepth >= maxDepth) return '';

    const lines: string[] = [];
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const filteredEntries = entries
        .filter(e => !e.name.startsWith('.') && !IGNORE_FOLDERS.has(e.name))
        .sort((a, b) => {
          // Directories first
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      for (let i = 0; i < filteredEntries.length; i++) {
        const entry = filteredEntries[i];
        const isLast = i === filteredEntries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const newPrefix = prefix + (isLast ? '    ' : '│   ');

        lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}`);

        if (entry.isDirectory()) {
          const subTree = await this.getDirectoryTree(
            path.join(dirPath, entry.name),
            maxDepth,
            currentDepth + 1,
            newPrefix
          );
          if (subTree) lines.push(subTree);
        }
      }
    } catch {
      // Skip unreadable directories
    }

    return lines.join('\n');
  }

  /**
   * Helper: Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Helper: Extract more comprehensive code samples
   */
  private async extractCodeSamplesDeep(
    repoPath: string,
    feature: DiscoveredFeature,
    maxFiles: number
  ): Promise<string> {
    const samples: string[] = [];
    let fileCount = 0;

    // Priority order: types/interfaces, routes/api, index files, services, other
    const priorityFiles = [
      ...feature.files.schema.filter(f => f.includes('types') || f.includes('interface') || f.endsWith('.d.ts')),
      ...feature.files.api.filter(f => f.includes('routes') || f.includes('api') || f.includes('controller')),
      ...feature.files.other.filter(f => f.endsWith('index.ts') || f.endsWith('index.js')),
      ...feature.files.api,
      ...feature.files.schema,
      ...feature.files.other.filter(f => f.includes('service') || f.includes('Service')),
    ];

    // Deduplicate
    const uniqueFiles = [...new Set(priorityFiles)];

    for (const file of uniqueFiles) {
      if (fileCount >= maxFiles) break;

      const fullPath = path.join(repoPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        // Truncate large files but keep more context
        const maxSize = 3000;
        const truncated = content.length > maxSize
          ? content.slice(0, maxSize) + '\n// ... truncated (' + (content.length - maxSize) + ' more chars)'
          : content;

        const ext = path.extname(file).replace('.', '') || 'txt';
        samples.push(`### ${file}\n\`\`\`${ext}\n${truncated}\n\`\`\``);
        fileCount++;
      } catch {
        // Skip unreadable files
      }
    }

    return samples.join('\n\n');
  }

  /**
   * Parse .gitmodules file to get list of declared git submodule paths
   * Only trusts .gitmodules - other detection is left to user
   */
  private async getGitSubmodulePaths(repoPath: string): Promise<Set<string>> {
    const excludedPaths = new Set<string>();

    // Only parse .gitmodules for declared git submodules
    const gitmodulesPath = path.join(repoPath, '.gitmodules');
    try {
      const content = await fs.readFile(gitmodulesPath, 'utf-8');
      const pathMatches = content.matchAll(/^\s*path\s*=\s*(.+)$/gm);
      for (const match of pathMatches) {
        const submodulePath = match[1].trim();
        excludedPaths.add(submodulePath);
        // Also add just the folder name for top-level matching
        const folderName = path.basename(submodulePath);
        excludedPaths.add(folderName);
        console.log(`[ContractGeneration] Registered git submodule from .gitmodules: ${submodulePath}`);
      }
      if (excludedPaths.size > 0) {
        console.log(`[ContractGeneration] Found ${excludedPaths.size} git submodule paths from .gitmodules`);
      }
    } catch {
      // No .gitmodules file - that's fine, no submodules to exclude
    }

    return excludedPaths;
  }

  /**
   * Get feature name from package.json if available, otherwise use folder name
   */
  private async getFeatureName(featurePath: string, fallbackName: string): Promise<string> {
    const packageJsonPath = path.join(featurePath, 'package.json');
    try {
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      if (pkg.name) {
        // Remove scope if present (e.g., @org/package-name -> package-name)
        const name = pkg.name.startsWith('@')
          ? pkg.name.split('/')[1] || pkg.name
          : pkg.name;
        return name;
      }
    } catch {
      // No package.json or can't parse it - use fallback
    }
    return fallbackName;
  }

  /**
   * AI feature info - stores name, description, and category for each discovered feature
   */
  private aiFeatureInfo: Map<string, { name: string; description?: string; category?: string }> = new Map();

  /**
   * Full AI-identified features - stores complete feature objects from AI
   */
  private aiIdentifiedFeaturesList: Array<{
    name: string;
    category?: string;
    paths: string[];
    description?: string;
  }> = [];

  /**
   * Use AI to identify SERVICE-LEVEL features from the codebase (V3 approach)
   * Returns the full list of AI-identified features, not just folder paths
   */
  private async identifyServiceLevelFeatures(
    repoPath: string,
    candidateFolders: string[]
  ): Promise<Array<{ name: string; category?: string; paths: string[]; keyFiles?: string[]; description?: string }> | null> {
    // Clear previous AI feature info
    this.aiFeatureInfo.clear();
    this.aiIdentifiedFeaturesList = [];

    try {
      // Get directory tree for context - use depth 5 to see services inside folders
      const directoryTree = await this.getDirectoryTree(repoPath, 5);

      // Format folder list
      const folderList = candidateFolders.map(f => `- ${f}`).join('\n');

      // Use AI to identify SERVICE-LEVEL features
      const result = await this.aiService.sendWithMode({
        modeId: 'contract_generator',
        promptKey: 'filter_features',
        variables: {
          repo_name: path.basename(repoPath),
          folder_list: folderList,
          directory_tree: directoryTree,
        },
        userMessage: 'Analyze the code structure and identify ALL SERVICE-LEVEL features. Return ONLY valid JSON with the features array. Each feature should have name, category, paths, and description.',
      });

      if (!result.success || !result.data) {
        console.warn('[ContractGeneration] AI feature identification failed:', result.error?.message);
        return null;
      }

      // Parse the JSON response
      try {
        let jsonStr = result.data.trim();
        // Remove markdown code fences if present
        if (jsonStr.includes('```json')) {
          jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        } else if (jsonStr.includes('```')) {
          jsonStr = jsonStr.replace(/```\n?/g, '');
        }

        const parsed = JSON.parse(jsonStr);

        if (parsed.features && Array.isArray(parsed.features)) {
          for (const f of parsed.features) {
            // Handle both old format (path) and new format (paths array)
            const paths = f.paths || (f.path ? [f.path] : []);
            const normalizedPaths = paths.map((p: string) => p.replace(/^\.?\//, ''));

            // Handle keyFiles - specific files that define this feature
            const keyFiles = f.keyFiles || [];
            const normalizedKeyFiles = keyFiles.map((p: string) => p.replace(/^\.?\//, ''));

            const feature = {
              name: f.name,
              category: f.category,
              paths: normalizedPaths,
              keyFiles: normalizedKeyFiles,
              description: f.description,
            };

            this.aiIdentifiedFeaturesList.push(feature);

            // Store feature info for each path (for compatibility)
            for (const featurePath of normalizedPaths) {
              this.aiFeatureInfo.set(featurePath, {
                name: f.name,
                description: f.description,
                category: f.category,
              });
            }

            console.log(`[ContractGeneration] AI identified service: "${f.name}" (${f.category || 'uncategorized'}) at [${normalizedPaths.join(', ')}] with ${normalizedKeyFiles.length} key files`);
          }

          console.log(`[ContractGeneration] Total AI-identified services: ${this.aiIdentifiedFeaturesList.length}`);
          return this.aiIdentifiedFeaturesList;
        }

        return null;
      } catch (parseErr) {
        console.warn('[ContractGeneration] Failed to parse AI response:', parseErr);
        return null;
      }
    } catch (err) {
      console.error('[ContractGeneration] Error in identifyServiceLevelFeatures:', err);
      return null;
    }
  }

  /**
   * Discover all features in a repository
   * @param repoPath - Path to the repository
   * @param useAI - If true, uses LLM to identify SERVICE-LEVEL features (V3 approach, default: true)
   */
  async discoverFeatures(repoPath: string, useAI = true): Promise<IpcResult<DiscoveredFeature[]>> {
    return this.wrap(async () => {
      console.log(`[ContractGeneration] Discovering features in ${repoPath} (useAI: ${useAI})`);
      const features: DiscoveredFeature[] = [];
      const processedNames = new Set<string>();

      // Get git submodule paths to exclude
      const submodulePaths = await this.getGitSubmodulePaths(repoPath);

      // Get .gitignore patterns
      let gitignorePatterns: string[] = [];
      try {
        const gitignorePath = path.join(repoPath, '.gitignore');
        const content = await fs.readFile(gitignorePath, 'utf-8');
        gitignorePatterns = parseGitignore(content);
        console.log(`[ContractGeneration] Loaded ${gitignorePatterns.length} patterns from .gitignore`);
      } catch {
        // No .gitignore, that's fine
      }

      // V3 APPROACH: Use AI to identify SERVICE-LEVEL features directly
      if (useAI) {
        console.log('[ContractGeneration] Using AI to identify SERVICE-LEVEL features (V3 approach)...');

        // First, collect all candidate folders (mechanical scan)
        const candidateFolders: string[] = [];
        try {
          const entries = await fs.readdir(repoPath, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('.')) continue;
            if (IGNORE_FOLDERS.has(entry.name)) continue;
            if (submodulePaths.has(entry.name)) continue;
            if (matchesGitignorePattern(entry.name, gitignorePatterns)) continue;
            candidateFolders.push(entry.name);
          }
        } catch {
          // Ignore errors
        }

        // Use AI to identify service-level features
        if (candidateFolders.length > 0) {
          const aiFeatures = await this.identifyServiceLevelFeatures(repoPath, candidateFolders);

          if (aiFeatures && aiFeatures.length > 0) {
            console.log(`[ContractGeneration] AI identified ${aiFeatures.length} service-level features`);

            // Create DiscoveredFeature objects directly from AI results
            for (const aiFeature of aiFeatures) {
              if (processedNames.has(aiFeature.name)) continue;
              processedNames.add(aiFeature.name);

              // Determine base path from the first path in the feature
              // paths are directories (not files), so use the full path
              const firstPath = aiFeature.paths[0] || '';
              const basePath = path.join(repoPath, firstPath);

              // Use keyFiles if provided (more specific), otherwise fall back to paths
              // keyFiles = specific files like "backend/src/routes/auth.ts"
              // paths = directories like "backend/src/routes"
              const keyFilePaths = (aiFeature.keyFiles || []).map(p => path.join(repoPath, p));
              const dirPaths = aiFeature.paths.map(p => path.join(repoPath, p));
              const specificFiles = keyFilePaths.length > 0 ? keyFilePaths : dirPaths;

              // Scan files for this feature, but filter to only include specificFiles if available
              let files: DiscoveredFeature['files'];
              try {
                const allFiles = await this.scanFeatureFiles(basePath, repoPath);

                // Filter scanned files to match AI-identified files/paths
                if (keyFilePaths.length > 0) {
                  // Use keyFiles for precise matching (file-level)
                  const filterByKeyFiles = (fileList: string[]) => {
                    return fileList.filter(f => {
                      const fullPath = path.isAbsolute(f) ? f : path.join(repoPath, f);
                      const fileName = path.basename(f);
                      // Match by full path OR by filename (for when paths are relative)
                      return keyFilePaths.some(kf =>
                        fullPath === kf ||
                        fullPath.endsWith(kf) ||
                        kf.endsWith(fileName) ||
                        f === kf.replace(repoPath + '/', '')
                      );
                    });
                  };
                  files = {
                    api: filterByKeyFiles(allFiles.api),
                    schema: filterByKeyFiles(allFiles.schema),
                    tests: {
                      unit: filterByKeyFiles(allFiles.tests.unit),
                      integration: filterByKeyFiles(allFiles.tests.integration),
                      e2e: filterByKeyFiles(allFiles.tests.e2e),
                    },
                    fixtures: filterByKeyFiles(allFiles.fixtures),
                    config: filterByKeyFiles(allFiles.config),
                    css: filterByKeyFiles(allFiles.css),
                    prompts: filterByKeyFiles(allFiles.prompts),
                    other: filterByKeyFiles(allFiles.other),
                  };
                } else if (dirPaths.length > 0) {
                  // Use directory paths for matching - strict prefix match only
                  const filterByDirPaths = (fileList: string[]) => {
                    return fileList.filter(f => {
                      const fullPath = path.isAbsolute(f) ? f : path.join(repoPath, f);
                      return dirPaths.some(dp => fullPath.startsWith(dp + path.sep) || fullPath === dp);
                    });
                  };

                  const filteredFiles = {
                    api: filterByDirPaths(allFiles.api),
                    schema: filterByDirPaths(allFiles.schema),
                    tests: {
                      unit: filterByDirPaths(allFiles.tests.unit),
                      integration: filterByDirPaths(allFiles.tests.integration),
                      e2e: filterByDirPaths(allFiles.tests.e2e),
                    },
                    fixtures: filterByDirPaths(allFiles.fixtures),
                    config: filterByDirPaths(allFiles.config),
                    css: filterByDirPaths(allFiles.css),
                    prompts: filterByDirPaths(allFiles.prompts),
                    other: filterByDirPaths(allFiles.other),
                  };

                  // Check if dirPaths filtering produced no narrowing (same as allFiles)
                  // This happens when all features share the same broad path (e.g., 'services')
                  const filteredTotal = filteredFiles.api.length + filteredFiles.schema.length +
                    filteredFiles.config.length + filteredFiles.tests.unit.length +
                    filteredFiles.tests.integration.length + filteredFiles.tests.e2e.length +
                    filteredFiles.fixtures.length + filteredFiles.other.length;
                  const allTotal = allFiles.api.length + allFiles.schema.length +
                    allFiles.config.length + allFiles.tests.unit.length +
                    allFiles.tests.integration.length + allFiles.tests.e2e.length +
                    allFiles.fixtures.length + allFiles.other.length;

                  if (filteredTotal === allTotal && allTotal > 0 && aiFeatures.length > 1) {
                    // dirPaths didn't narrow results - fall back to name-based matching
                    // Derive keywords from the feature name to match against file paths
                    const nameWords = aiFeature.name.toLowerCase()
                      .replace(/[&]/g, ' ')
                      .split(/\s+/)
                      .filter(w => w.length > 2 && !['and', 'the', 'for', 'with'].includes(w));

                    const filterByName = (fileList: string[]) => {
                      return fileList.filter(f => {
                        const lowerPath = f.toLowerCase();
                        return nameWords.some(w => lowerPath.includes(w));
                      });
                    };

                    files = {
                      api: filterByName(allFiles.api),
                      schema: filterByName(allFiles.schema),
                      tests: {
                        unit: filterByName(allFiles.tests.unit),
                        integration: filterByName(allFiles.tests.integration),
                        e2e: filterByName(allFiles.tests.e2e),
                      },
                      fixtures: filterByName(allFiles.fixtures),
                      config: filterByName(allFiles.config),
                      css: filterByName(allFiles.css),
                      prompts: filterByName(allFiles.prompts),
                      other: filterByName(allFiles.other),
                    };

                    console.log(`[ContractGeneration] Used name-based matching for "${aiFeature.name}" (keywords: ${nameWords.join(', ')})`);
                  } else {
                    files = filteredFiles;
                  }
                } else {
                  files = allFiles;
                }
              } catch {
                files = { api: [], schema: [], tests: { unit: [], integration: [], e2e: [] }, fixtures: [], config: [], css: [], prompts: [], other: [] };
              }

              features.push({
                name: aiFeature.name,
                description: aiFeature.description,
                basePath,
                specificFiles, // Store for contract generation
                files,
                contractPatternMatches: files.api.length + files.schema.length + files.other.length,
              });

              console.log(`[ContractGeneration] Created feature: ${aiFeature.name} with ${keyFilePaths.length} keyFiles, ${files.api.length} API files (${aiFeature.category || 'uncategorized'})`);
            }

            // If we successfully identified features via AI, return them
            if (features.length > 0) {
              console.log(`[ContractGeneration] Total features discovered: ${features.length}`);
              return features;
            }
          } else {
            console.warn('[ContractGeneration] AI feature identification failed, falling back to folder scan');
          }
        }
      }

      // FALLBACK: Folder-level scanning (when AI is disabled or fails)
      console.log('[ContractGeneration] Using folder-level scanning (fallback)...');
      const processedPaths = new Set<string>();

      try {
        const entries = await fs.readdir(repoPath, { withFileTypes: true });
        console.log(`[ContractGeneration] Found ${entries.length} entries in ${repoPath}`);

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue;
          if (IGNORE_FOLDERS.has(entry.name)) {
            console.log(`[ContractGeneration] Skipping ignored folder: ${entry.name}`);
            continue;
          }

          // Skip git submodules
          if (submodulePaths.has(entry.name)) {
            console.log(`[ContractGeneration] Skipping git submodule: ${entry.name}`);
            continue;
          }

          // Skip gitignored paths
          if (matchesGitignorePattern(entry.name, gitignorePatterns)) {
            console.log(`[ContractGeneration] Skipping gitignored folder: ${entry.name}`);
            continue;
          }

          const featurePath = path.join(repoPath, entry.name);
          if (processedPaths.has(featurePath)) continue;

          console.log(`[ContractGeneration] Scanning folder: ${entry.name}`);
          const files = await this.scanFeatureFiles(featurePath, repoPath);
          const totalFiles = this.countFeatureFiles(files);
          console.log(`[ContractGeneration] ${entry.name}: ${totalFiles} files`);

          if (totalFiles > 0) {
            processedPaths.add(featurePath);
            const featureName = await this.getFeatureName(featurePath, entry.name);
            features.push({
              name: featureName,
              basePath: featurePath,
              files,
              contractPatternMatches: totalFiles,
            });
            console.log(`[ContractGeneration] Found feature (fallback): ${featureName} (${totalFiles} files)`);
          }
        }
      } catch (err) {
        console.error('[ContractGeneration] Error scanning top-level:', err);
      }

      // 2. Also scan nested feature folders in fallback mode (src/features/*, packages/*, etc)
      for (const pattern of FEATURE_FOLDER_PATTERNS) {
        if (pattern === '*') continue; // Already handled above
        const fullPattern = path.join(repoPath, pattern);
        try {
          const globSync = await getGlobSync();
          const matches = globSync(fullPattern, {
            nodir: false,
            ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
          });

          for (const featurePath of matches) {
            const stat = await fs.stat(featurePath).catch(() => null);
            if (!stat?.isDirectory()) continue;
            if (processedPaths.has(featurePath)) continue;

            const folderName = path.basename(featurePath);
            if (IGNORE_FOLDERS.has(folderName)) continue;

            // Check if this path is a submodule
            const relativePath = path.relative(repoPath, featurePath);
            if (submodulePaths.has(relativePath) || submodulePaths.has(folderName)) {
              console.log(`[ContractGeneration] Skipping git submodule: ${relativePath}`);
              continue;
            }

            // Check gitignore
            if (matchesGitignorePattern(folderName, gitignorePatterns) || matchesGitignorePattern(relativePath, gitignorePatterns)) {
              console.log(`[ContractGeneration] Skipping gitignored path: ${relativePath}`);
              continue;
            }

            const files = await this.scanFeatureFiles(featurePath, repoPath);
            const totalFiles = this.countFeatureFiles(files);

            if (totalFiles > 0) {
              processedPaths.add(featurePath);
              const featureName = await this.getFeatureName(featurePath, folderName);
              features.push({
                name: featureName,
                basePath: featurePath,
                files,
                contractPatternMatches: totalFiles,
              });
              console.log(`[ContractGeneration] Found feature (fallback nested): ${featureName} (${totalFiles} files)`);
            }
          }
        } catch {
          // Pattern didn't match anything, continue
        }
      }

      // 3. If still no features found in fallback mode, treat root as single feature
      if (features.length === 0) {
        console.log('[ContractGeneration] No feature folders found, analyzing root as single feature...');
        const rootFeature = await this.analyzeRootAsFeature(repoPath);
        if (rootFeature && this.countFeatureFiles(rootFeature.files) > 0) {
          features.push(rootFeature);
        }
      }

      // 4. Deduplicate features by name (merge features with same name)
      const deduplicatedFeatures = this.deduplicateFeatures(features);
      console.log(`[ContractGeneration] Discovered ${features.length} features, deduplicated to ${deduplicatedFeatures.length}`);
      return deduplicatedFeatures;
    }, 'DISCOVER_FEATURES_ERROR');
  }

  /**
   * Deduplicate features by merging those with the same name
   */
  private deduplicateFeatures(features: DiscoveredFeature[]): DiscoveredFeature[] {
    const featureMap = new Map<string, DiscoveredFeature>();

    for (const feature of features) {
      const normalizedName = feature.name.toLowerCase().trim();
      const existing = featureMap.get(normalizedName);

      if (existing) {
        // Merge files from both features
        console.log(`[ContractGeneration] Merging duplicate feature: ${feature.name} (${feature.basePath}) into existing (${existing.basePath})`);

        // Merge file arrays
        existing.files.api = [...new Set([...existing.files.api, ...feature.files.api])];
        existing.files.schema = [...new Set([...existing.files.schema, ...feature.files.schema])];
        existing.files.config = [...new Set([...existing.files.config, ...feature.files.config])];
        existing.files.fixtures = [...new Set([...existing.files.fixtures, ...feature.files.fixtures])];
        existing.files.css = [...new Set([...(existing.files.css || []), ...(feature.files.css || [])])];
        existing.files.prompts = [...new Set([...(existing.files.prompts || []), ...(feature.files.prompts || [])])];
        existing.files.other = [...new Set([...existing.files.other, ...feature.files.other])];
        existing.files.tests.unit = [...new Set([...existing.files.tests.unit, ...feature.files.tests.unit])];
        existing.files.tests.e2e = [...new Set([...existing.files.tests.e2e, ...feature.files.tests.e2e])];
        existing.files.tests.integration = [...new Set([...existing.files.tests.integration, ...feature.files.tests.integration])];

        // Update contract pattern matches
        existing.contractPatternMatches = this.countFeatureFiles(existing.files);

        // Keep the more specific basePath (longer path = more specific)
        if (feature.basePath.length > existing.basePath.length) {
          existing.basePath = feature.basePath;
        }

        // Keep the longer/better description
        if (feature.description && (!existing.description || feature.description.length > existing.description.length)) {
          existing.description = feature.description;
        }
      } else {
        // Add new feature (use original casing for name)
        featureMap.set(normalizedName, { ...feature });
      }
    }

    return Array.from(featureMap.values());
  }

  /**
   * Scan a feature directory for contract-related files
   */
  private async scanFeatureFiles(
    featurePath: string,
    repoPath: string
  ): Promise<DiscoveredFeature['files']> {
    const files: DiscoveredFeature['files'] = {
      api: [],
      schema: [],
      tests: { e2e: [], unit: [], integration: [] },
      fixtures: [],
      config: [],
      css: [],
      prompts: [],
      other: [],
    };

    // Scan for each pattern type
    for (const [category, patterns] of Object.entries(CONTRACT_PATTERNS)) {
      for (const pattern of patterns) {
        const fullPattern = path.join(featurePath, pattern);
        try {
          const globSync = await getGlobSync();
          const matches = globSync(fullPattern, {
            ignore: ['**/node_modules/**', '**/.git/**'],
          });

          // Ensure matches is an array
          const matchArray = Array.isArray(matches) ? matches : [];

          for (const match of matchArray) {
          const relativePath = path.relative(repoPath, match);

          switch (category) {
            case 'api':
              if (!files.api.includes(relativePath)) files.api.push(relativePath);
              break;
            case 'schema':
              if (!files.schema.includes(relativePath)) files.schema.push(relativePath);
              break;
            case 'e2e':
              if (!files.tests.e2e.includes(relativePath)) files.tests.e2e.push(relativePath);
              break;
            case 'unit':
              // Exclude e2e files from unit
              if (!relativePath.includes('.e2e.') && !relativePath.includes('/e2e/')) {
                if (!files.tests.unit.includes(relativePath)) files.tests.unit.push(relativePath);
              }
              break;
            case 'integration':
              if (!files.tests.integration.includes(relativePath)) files.tests.integration.push(relativePath);
              break;
            case 'fixtures':
              if (!files.fixtures.includes(relativePath)) files.fixtures.push(relativePath);
              break;
            case 'config':
              if (!files.config.includes(relativePath)) files.config.push(relativePath);
              break;
            case 'css':
              if (!files.css.includes(relativePath)) files.css.push(relativePath);
              break;
            case 'prompts':
              if (!files.prompts.includes(relativePath)) files.prompts.push(relativePath);
              break;
          }
          }
        } catch {
          // Pattern didn't match or glob error, continue
        }
      }
    }

    // Also scan for general source files (to ensure we discover features even without contract-specific files)
    // Only log once for debugging
    let loggedPattern = false;
    for (const pattern of SOURCE_PATTERNS) {
      const fullPattern = path.join(featurePath, pattern);
      try {
        const globSync = await getGlobSync();
          const matches = globSync(fullPattern, {
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        });
        const matchArray = Array.isArray(matches) ? matches : [];
        if (!loggedPattern && matchArray.length > 0) {
          console.log(`[ContractGeneration] Pattern ${pattern} found ${matchArray.length} files in ${path.basename(featurePath)}`);
          loggedPattern = true;
        }
        for (const match of matchArray) {
          const relativePath = path.relative(repoPath, match);
          // Only add if not already categorized
          const alreadyCategorized =
            files.api.includes(relativePath) ||
            files.schema.includes(relativePath) ||
            files.tests.e2e.includes(relativePath) ||
            files.tests.unit.includes(relativePath) ||
            files.tests.integration.includes(relativePath) ||
            files.fixtures.includes(relativePath) ||
            files.config.includes(relativePath) ||
            files.css.includes(relativePath) ||
            files.prompts.includes(relativePath);
          if (!alreadyCategorized && !files.other.includes(relativePath)) {
            files.other.push(relativePath);
          }
        }
      } catch (err) {
        // Log first error
        if (!loggedPattern) {
          console.error(`[ContractGeneration] Glob error for ${fullPattern}:`, err);
          loggedPattern = true;
        }
      }
    }

    // Smart scan: limit "other" files when there are many, to avoid overwhelming the LLM
    const SMART_SCAN_OTHER_THRESHOLD = 30;
    if (files.other.length >= SMART_SCAN_OTHER_THRESHOLD) {
      const categorizedFiles = [
        ...files.api,
        ...files.schema,
        ...files.tests.e2e,
        ...files.tests.unit,
        ...files.tests.integration,
        ...files.fixtures,
        ...files.config,
        ...files.css,
        ...files.prompts,
      ];

      if (categorizedFiles.length > 0) {
        // Collect grandparent directories of categorized files (relative paths)
        const adjacentDirs = new Set<string>();
        for (const f of categorizedFiles) {
          const parent = path.dirname(f);
          const grandparent = path.dirname(parent);
          // Skip if grandparent is the root ('.') — that would match everything
          if (grandparent && grandparent !== '.') {
            adjacentDirs.add(grandparent);
          }
        }

        if (adjacentDirs.size > 0) {
          files.other = files.other.filter((f) =>
            [...adjacentDirs].some((dir) => f.startsWith(dir + '/'))
          );
        }
      } else {
        // No categorized files: sort by path depth (shallowest first) and cap at threshold
        files.other = files.other
          .slice()
          .sort((a, b) => a.split('/').length - b.split('/').length)
          .slice(0, SMART_SCAN_OTHER_THRESHOLD);
      }
    }

    return files;
  }

  /**
   * Analyze repository root as a single feature (fallback)
   */
  private async analyzeRootAsFeature(repoPath: string): Promise<DiscoveredFeature | null> {
    const repoName = path.basename(repoPath);
    const files = await this.scanFeatureFiles(repoPath, repoPath);

    return {
      name: repoName,
      basePath: repoPath,
      files,
      contractPatternMatches: this.countFeatureFiles(files),
    };
  }

  /**
   * Count total files in a feature
   */
  private countFeatureFiles(files: DiscoveredFeature['files']): number {
    return (
      files.api.length +
      files.schema.length +
      files.tests.e2e.length +
      files.tests.unit.length +
      files.tests.integration.length +
      files.fixtures.length +
      files.config.length +
      (files.css?.length || 0) +
      (files.prompts?.length || 0) +
      files.other.length
    );
  }

  /**
   * Generate contract for a single feature
   */
  async generateFeatureContract(
    repoPath: string,
    feature: DiscoveredFeature,
    options: ContractGenerationOptions = {}
  ): Promise<IpcResult<GeneratedContractResult>> {
    return this.wrap(async () => {
      console.log(`[ContractGeneration] Generating contract for feature: ${feature.name}`);

      // Extract code samples for AI context
      const codeSamples = options.includeCodeSamples !== false
        ? await this.extractCodeSamples(repoPath, feature, options.maxFilesPerFeature || 10)
        : '';

      // Build analysis JSON for prompt (combines file lists and code samples)
      const analysisJson = {
        feature: feature.name,
        description: feature.description || 'No description available',
        basePath: path.relative(repoPath, feature.basePath),
        files: {
          api: feature.files.api,
          schema: feature.files.schema,
          tests: {
            e2e: feature.files.tests.e2e,
            unit: feature.files.tests.unit,
            integration: feature.files.tests.integration,
          },
          fixtures: feature.files.fixtures,
          config: feature.files.config,
          css: feature.files.css || [],
          prompts: feature.files.prompts || [],
          other: feature.files.other,
        },
        codeSamples: codeSamples || 'No code samples available',
        totalFiles: feature.contractPatternMatches,
      };

      console.log(`[ContractGeneration] Analysis JSON for ${feature.name}:`, JSON.stringify(analysisJson, null, 2).slice(0, 2000));

      // Generate Markdown contract using AI
      this.emitProgress({
        total: this.currentProgress?.total || 0,
        completed: this.currentProgress?.completed || 0,
        currentFeature: feature.name,
        currentStep: 'generating',
        contractType: 'markdown',
        errors: this.currentProgress?.errors || [],
      });
      const markdownResult = await this.aiService.sendWithMode({
        modeId: 'contract_generator',
        promptKey: 'generate_feature_contract',
        variables: {
          feature_name: feature.name,
          feature_path: path.relative(repoPath, feature.basePath),
          analysis_json: JSON.stringify(analysisJson, null, 2),
        },
      });

      if (!markdownResult.success || !markdownResult.data) {
        throw new Error(`Failed to generate markdown: ${markdownResult.error?.message}`);
      }

      console.log(`[ContractGeneration] Raw AI response for ${feature.name}:`, markdownResult.data.slice(0, 1000));

      // Clean up AI response - remove any "thinking" text before the actual contract
      let cleanedMarkdown = this.cleanupAIResponse(markdownResult.data);

      // Generate JSON contract using AI
      this.emitProgress({
        total: this.currentProgress?.total || 0,
        completed: this.currentProgress?.completed || 0,
        currentFeature: feature.name,
        currentStep: 'generating',
        contractType: 'json',
        errors: this.currentProgress?.errors || [],
      });
      const jsonResult = await this.aiService.sendWithMode({
        modeId: 'contract_generator',
        promptKey: 'generate_json_contract',
        variables: {
          feature_name: feature.name,
          feature_path: path.relative(repoPath, feature.basePath),
          analysis_json: JSON.stringify(analysisJson, null, 2),
        },
      });

      let jsonContract: GeneratedContractJSON;
      if (jsonResult.success && jsonResult.data) {
        try {
          // Parse AI response as JSON (may have markdown fences)
          let jsonStr = jsonResult.data.trim();
          if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
          }
          jsonContract = JSON.parse(jsonStr);
        } catch {
          console.warn(`[ContractGeneration] Failed to parse JSON, using fallback`);
          jsonContract = await this.createFallbackJSON(feature, repoPath);
        }
      } else {
        jsonContract = await this.createFallbackJSON(feature, repoPath);
      }

      // Generate Admin contract using AI
      this.emitProgress({
        total: this.currentProgress?.total || 0,
        completed: this.currentProgress?.completed || 0,
        currentFeature: feature.name,
        currentStep: 'generating',
        contractType: 'admin',
        errors: this.currentProgress?.errors || [],
      });
      console.log(`[ContractGeneration] Generating admin contract for: ${feature.name}`);
      const adminResult = await this.aiService.sendWithMode({
        modeId: 'contract_generator',
        promptKey: 'generate_admin_contract',
        variables: {
          feature_name: feature.name,
          feature_path: path.relative(repoPath, feature.basePath),
          analysis_json: JSON.stringify(jsonContract, null, 2),
        },
      });

      let adminContract: Record<string, unknown> | null = null;
      if (adminResult.success && adminResult.data) {
        try {
          let adminStr = adminResult.data.trim();
          if (adminStr.startsWith('```')) {
            adminStr = adminStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
          }
          adminContract = JSON.parse(adminStr);
          // Add admin contract to the main JSON contract
          (jsonContract as unknown as Record<string, unknown>).adminContract = adminContract;
          console.log(`[ContractGeneration] Admin contract generated for: ${feature.name}`);
        } catch (err) {
          console.warn(`[ContractGeneration] Failed to parse admin contract:`, err);
        }
      }

      // Save contracts (use cleaned markdown, not raw AI response)
      const savedPaths = await this.saveContract(
        repoPath,
        feature,
        cleanedMarkdown,
        jsonContract
      );

      return {
        feature: feature.name,
        success: true,
        markdownPath: savedPaths.markdownPath,
        jsonPath: savedPaths.jsonPath,
      };
    }, 'GENERATE_CONTRACT_ERROR');
  }

  /**
   * Extract code samples from key files for AI context
   */
  private async extractCodeSamples(
    repoPath: string,
    feature: DiscoveredFeature,
    maxFiles: number
  ): Promise<string> {
    const samples: string[] = [];
    let fileCount = 0;

    // Prioritize type/interface files and API routes
    const priorityFiles = [
      ...feature.files.schema.filter(f => f.includes('types') || f.includes('interface')),
      ...feature.files.api.filter(f => f.includes('routes') || f.includes('api')),
      ...feature.files.schema.slice(0, 3),
    ];

    for (const file of priorityFiles) {
      if (fileCount >= maxFiles) break;

      const fullPath = path.join(repoPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        // Truncate large files
        const truncated = content.length > 2000
          ? content.slice(0, 2000) + '\n// ... truncated'
          : content;

        samples.push(`### ${file}\n\`\`\`typescript\n${truncated}\n\`\`\``);
        fileCount++;
      } catch {
        // Skip unreadable files
      }
    }

    return samples.join('\n\n');
  }

  /**
   * Create fallback JSON contract when AI fails
   * Enhanced with AST data when analysis services are available (Phase 3)
   */
  private async createFallbackJSON(feature: DiscoveredFeature, repoPath: string): Promise<GeneratedContractJSON> {
    // Extract analysis data if services are available
    const analysisData = await this.extractAnalysisData(feature, repoPath);

    return {
      feature: feature.name,
      version: '1.0.0',
      lastGenerated: new Date().toISOString(),
      generatorVersion: '1.0.0',
      overview: `Auto-generated contract for ${feature.name} feature`,
      apis: {
        endpoints: analysisData.endpoints.map(ep => ({
          method: ep.method,
          path: ep.path,
          description: `Handler: ${ep.handler}`,
          file: ep.file,
        })),
        exports: analysisData.exports.map(exp => ({
          name: exp.name,
          type: exp.type as 'function' | 'class' | 'interface' | 'type' | 'const',
          file: exp.file,
          line: exp.line,
          signature: exp.signature,
        })),
      },
      schemas: analysisData.schemas.map(schema => ({
        name: schema.name,
        type: 'interface' as const,
        file: schema.file,
        columns: schema.columns?.map(c => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          primaryKey: c.primaryKey,
        })),
      })),
      dependencies: analysisData.dependencies,
      testCoverage: {
        e2e: { count: feature.files.tests.e2e.length, files: feature.files.tests.e2e },
        unit: { count: feature.files.tests.unit.length, files: feature.files.tests.unit },
        integration: { count: feature.files.tests.integration.length, files: feature.files.tests.integration },
      },
      breakingChangeFiles: [...feature.files.api.slice(0, 5), ...feature.files.schema.slice(0, 5)],
      sourceFiles: [
        ...feature.files.api,
        ...feature.files.schema,
        ...feature.files.tests.e2e,
        ...feature.files.tests.unit,
        ...feature.files.tests.integration,
        ...feature.files.fixtures,
        ...feature.files.config,
        ...(feature.files.css || []),
        ...(feature.files.prompts || []),
        ...feature.files.other,
      ],
    };
  }

  /**
   * Extract analysis data from feature files using analysis services (Phase 3)
   */
  private async extractAnalysisData(
    feature: DiscoveredFeature,
    repoPath: string
  ): Promise<{
    exports: Array<{ name: string; type: string; file: string; line: number; signature?: string }>;
    endpoints: ExtractedEndpoint[];
    schemas: ExtractedSchema[];
    dependencies: string[];
  }> {
    const result = {
      exports: [] as Array<{ name: string; type: string; file: string; line: number; signature?: string }>,
      endpoints: [] as ExtractedEndpoint[],
      schemas: [] as ExtractedSchema[],
      dependencies: [] as string[],
    };

    // If analysis services not available, return empty data
    if (!this.astParser || !this.apiExtractor || !this.schemaExtractor) {
      console.log('[ContractGeneration] Analysis services not available, using basic extraction');
      return result;
    }

    try {
      // Extract exports from all source files using AST parser
      const allFiles = [
        ...feature.files.api,
        ...feature.files.schema,
        ...feature.files.other,
      ];

      for (const relFile of allFiles.slice(0, 20)) { // Limit to prevent slowdown
        const absPath = path.join(repoPath, relFile);
        try {
          const ast = await this.astParser.parseFile(absPath);
          if (ast) {
            for (const exp of ast.exports) {
              result.exports.push({
                name: exp.name,
                type: exp.type,
                file: relFile,
                line: exp.line,
                signature: exp.signature,
              });
            }
          }
        } catch {
          // Skip files that fail to parse
        }
      }

      // Extract API endpoints
      const apiFiles = feature.files.api.map(f => ({
        path: path.join(repoPath, f),
      }));
      if (apiFiles.length > 0) {
        const endpoints = await this.apiExtractor.extractFromFiles(apiFiles);
        result.endpoints.push(...endpoints);
      }

      // Extract schemas
      const schemaFiles = feature.files.schema.map(f => ({
        path: path.join(repoPath, f),
      }));
      if (schemaFiles.length > 0) {
        const schemas = await this.schemaExtractor.extractFromFiles(schemaFiles);
        result.schemas.push(...schemas);
      }

      // Collect dependencies from AST imports
      const depSet = new Set<string>();
      for (const relFile of allFiles.slice(0, 20)) {
        const absPath = path.join(repoPath, relFile);
        try {
          const ast = await this.astParser.parseFile(absPath);
          if (ast) {
            for (const imp of ast.imports) {
              if (!imp.source.startsWith('.') && !imp.source.startsWith('/')) {
                // External dependency
                const pkgName = imp.source.split('/')[0];
                if (!pkgName.startsWith('@')) {
                  depSet.add(pkgName);
                } else {
                  // Scoped package
                  const parts = imp.source.split('/');
                  if (parts.length >= 2) {
                    depSet.add(`${parts[0]}/${parts[1]}`);
                  }
                }
              }
            }
          }
        } catch {
          // Skip files that fail to parse
        }
      }
      result.dependencies = Array.from(depSet);

      console.log(`[ContractGeneration] Extracted ${result.exports.length} exports, ${result.endpoints.length} endpoints, ${result.schemas.length} schemas for ${feature.name}`);
    } catch (error) {
      console.error('[ContractGeneration] Error extracting analysis data:', error);
    }

    return result;
  }

  /**
   * Clean up AI response - remove any "thinking" text or preamble before the actual contract content
   * Handles cases where AI returns "I'll analyze..." or "Let me..." before the contract
   */
  private cleanupAIResponse(response: string): string {
    let cleaned = response.trim();

    // Remove common AI preamble patterns - expanded list
    const preamblePatterns = [
      /^I'll analyze.*?\n+/i,
      /^I will analyze.*?\n+/i,
      /^Let me (analyze|examine|generate|create|look).*?\n+/i,
      /^I will (analyze|examine|generate|create).*?\n+/i,
      /^Here('s| is) (the|a) (contract|document|markdown|analysis).*?\n+/i,
      /^Based on (the|my) analysis.*?\n+/i,
      /^Looking at (the|this).*?\n+/i,
      /^After (analyzing|examining|reviewing).*?\n+/i,
      /^First, (let me|I'll|I will).*?\n+/i,
      /^Now (let me|I'll|I will).*?\n+/i,
    ];

    for (const pattern of preamblePatterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    // If content starts with a code fence but is supposed to be markdown, extract it
    if (cleaned.startsWith('```markdown') || cleaned.startsWith('```md')) {
      cleaned = cleaned.replace(/^```(?:markdown|md)\n?/, '').replace(/\n?```$/, '');
    }

    // If the response is mostly Python code or other code (not markdown), it's a bad response
    // Check if it starts with ``` and a language other than markdown
    const codeBlockMatch = cleaned.match(/^```(\w+)\n/);
    if (codeBlockMatch && !['markdown', 'md', ''].includes(codeBlockMatch[1])) {
      // The AI returned code instead of a contract - return a placeholder
      console.warn(`[ContractGeneration] AI returned code block (${codeBlockMatch[1]}) instead of contract markdown`);
      return `# Contract

> This contract needs to be regenerated. The AI did not return proper contract content.

## Status
- Generation failed: AI returned ${codeBlockMatch[1]} code instead of markdown contract.
- Please try regenerating this contract.
`;
    }

    // Check if content looks like Python code without code fences
    const looksLikePython = (
      cleaned.startsWith('import ') ||
      cleaned.startsWith('from ') ||
      cleaned.startsWith('def ') ||
      cleaned.startsWith('class ') ||
      /^(import \w+|from \w+ import)/m.test(cleaned.slice(0, 200))
    );

    if (looksLikePython) {
      console.warn('[ContractGeneration] AI returned Python code instead of contract markdown');
      return `# Contract

> This contract needs to be regenerated. The AI returned Python code instead of proper documentation.

## Status
- Generation failed: Response was Python code instead of markdown contract.
- Please try regenerating this contract.
`;
    }

    // Ensure it starts with a markdown heading
    if (!cleaned.startsWith('#')) {
      // Try to find the first heading
      const headingMatch = cleaned.match(/^(#+ .+)$/m);
      if (headingMatch) {
        const headingIndex = cleaned.indexOf(headingMatch[0]);
        if (headingIndex > 0 && headingIndex < 500) {
          // Remove content before the first heading (likely AI preamble)
          cleaned = cleaned.substring(headingIndex);
        }
      }
    }

    return cleaned.trim();
  }

  /**
   * Get existing contract version from JSON file or default to 1.0.0
   */
  private async getExistingContractVersion(jsonPath: string): Promise<string> {
    try {
      const content = await fs.readFile(jsonPath, 'utf-8');
      const json = JSON.parse(content);
      return json.version || '1.0.0';
    } catch {
      return '1.0.0';
    }
  }

  /**
   * Increment version number (1.0.0 -> 1.0.1, 1.0.9 -> 1.1.0, etc.)
   */
  private incrementVersion(version: string): string {
    const parts = version.split('.').map(Number);
    if (parts.length !== 3) return '1.0.1';

    parts[2]++; // Increment patch
    if (parts[2] >= 10) {
      parts[2] = 0;
      parts[1]++; // Increment minor
    }
    if (parts[1] >= 10) {
      parts[1] = 0;
      parts[0]++; // Increment major
    }
    return parts.join('.');
  }

  /**
   * Save contract to both feature folder and registry
   */
  private async saveContract(
    repoPath: string,
    feature: DiscoveredFeature,
    markdown: string,
    json: GeneratedContractJSON
  ): Promise<{ markdownPath: string; jsonPath: string }> {
    // Determine paths
    const registryDir = path.join(repoPath, KANVAS_PATHS.baseDir, 'contracts', 'features');
    await fs.mkdir(registryDir, { recursive: true });
    const jsonPath = path.join(registryDir, `${feature.name}.contracts.json`);

    // Get existing version and increment
    const existingVersion = await this.getExistingContractVersion(jsonPath);
    const newVersion = this.incrementVersion(existingVersion);

    // Update JSON with new version
    json.version = newVersion;
    json.lastGenerated = new Date().toISOString();

    // Update markdown with version header
    const versionHeader = `<!-- Version: ${newVersion} | Generated: ${json.lastGenerated} -->\n\n`;
    const markdownWithVersion = versionHeader + markdown;

    // 1. Save Markdown to feature folder with feature name in filename
    // Sanitize feature name for filename (replace spaces and special chars)
    const sanitizedName = feature.name.replace(/[^a-zA-Z0-9-_]/g, '_');
    const markdownPath = path.join(feature.basePath, `CONTRACTS_${sanitizedName}.md`);
    await fs.writeFile(markdownPath, markdownWithVersion, 'utf-8');
    console.log(`[ContractGeneration] Saved markdown v${newVersion}: ${markdownPath}`);

    // 2. Save JSON to registry (version already updated above)
    await fs.writeFile(jsonPath, JSON.stringify(json, null, 2), 'utf-8');
    console.log(`[ContractGeneration] Saved JSON v${newVersion}: ${jsonPath}`);

    // 3. Save to database for versioned history
    try {
      databaseService.saveContract({
        repoPath,
        contractType: 'feature',
        name: feature.name,
        version: newVersion,
        content: markdownWithVersion,
        jsonContent: JSON.stringify(json, null, 2),
        filePath: markdownPath,
        featureName: feature.name,
        isRepoLevel: false,
      });
      console.log(`[ContractGeneration] Saved to database v${newVersion}: ${feature.name}`);
    } catch (dbErr) {
      console.warn(`[ContractGeneration] Failed to save to database:`, dbErr);
      // Don't fail the generation if database save fails
    }

    return { markdownPath, jsonPath };
  }

  /**
   * Generate contracts for all features in a repository
   * By default uses incremental mode (only processes features with changes since last run)
   * Set forceRefresh=true to regenerate all contracts
   */
  async generateAllContracts(
    repoPath: string,
    options: ContractGenerationOptions = {}
  ): Promise<IpcResult<BatchContractGenerationResult>> {
    return this.wrap(async () => {
      this.isCancelled = false;
      const startTime = Date.now();
      const results: GeneratedContractResult[] = [];

      // Use pre-discovered features if provided, otherwise discover
      let features: DiscoveredFeature[];

      if (options.preDiscoveredFeatures && options.preDiscoveredFeatures.length > 0) {
        console.log(`[ContractGeneration] Using ${options.preDiscoveredFeatures.length} pre-discovered features`);
        features = options.preDiscoveredFeatures;
      } else {
        this.emitProgress({
          total: 0,
          completed: 0,
          currentFeature: 'Discovering features...',
          currentStep: 'discovering',
          errors: [],
        });

        const discoverResult = await this.discoverFeatures(repoPath, options.useAI);
        if (!discoverResult.success || !discoverResult.data) {
          throw new Error(`Failed to discover features: ${discoverResult.error?.message}`);
        }
        features = discoverResult.data;
      }

      // Filter to specific features if requested
      if (options.features && options.features.length > 0) {
        features = features.filter(f => options.features!.includes(f.name));
      }

      // Incremental mode: Only process features with changes since last run
      // Unless forceRefresh is true or this is the first run
      let featuresToProcess = features;
      let isIncremental = false;
      const currentCommitHash = await this.getCurrentCommitHash(repoPath);

      if (!options.forceRefresh) {
        const isFirst = await this.isFirstRun(repoPath);
        if (!isFirst) {
          const metadata = await this.getGenerationMetadata(repoPath);
          if (metadata && metadata.lastCommitHash && metadata.lastCommitHash !== currentCommitHash) {
            const changedFiles = await this.getChangedFilesSinceCommit(repoPath, metadata.lastCommitHash);
            if (changedFiles.length > 0) {
              featuresToProcess = this.getFeaturesWithChanges(features, changedFiles, repoPath);
              isIncremental = true;
              console.log(`[ContractGeneration] Incremental mode: ${changedFiles.length} files changed, ${featuresToProcess.length}/${features.length} features affected`);
            } else {
              console.log(`[ContractGeneration] No changes detected since last generation`);
              featuresToProcess = [];
              isIncremental = true;
            }
          } else if (metadata && metadata.lastCommitHash === currentCommitHash) {
            console.log(`[ContractGeneration] No new commits since last generation`);
            featuresToProcess = [];
            isIncremental = true;
          }
        } else {
          console.log(`[ContractGeneration] First run detected, processing all features`);
        }
      } else {
        console.log(`[ContractGeneration] Force refresh mode, processing all features`);
      }

      console.log(`[ContractGeneration] Generating contracts for ${featuresToProcess.length} features${isIncremental ? ' (incremental)' : ''}`);

      // If no features to process (incremental with no changes), return early with success
      if (featuresToProcess.length === 0 && isIncremental) {
        const batchResult: BatchContractGenerationResult = {
          totalFeatures: features.length,
          generated: 0,
          skipped: features.length,
          failed: 0,
          results: features.map(f => ({
            feature: f.name,
            success: true,
            markdownPath: path.join(f.basePath, `CONTRACTS_${f.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.md`),
          })),
          duration: Date.now() - startTime,
        };
        this.emitToRenderer(IPC.CONTRACT_GENERATION_COMPLETE, batchResult);
        console.log(`[ContractGeneration] No changes detected, skipped all ${features.length} features`);
        return batchResult;
      }

      // Generate contract for each feature that needs processing
      for (let i = 0; i < featuresToProcess.length; i++) {
        if (this.isCancelled) {
          console.log('[ContractGeneration] Cancelled by user');
          break;
        }

        const feature = featuresToProcess[i];

        this.emitProgress({
          total: featuresToProcess.length,
          completed: i,
          currentFeature: feature.name,
          currentStep: 'generating',
          errors: results.filter(r => !r.success).map(r => r.error || 'Unknown error'),
        });

        // Check if should skip existing (only in non-incremental mode or forceRefresh)
        if (options.skipExisting && !isIncremental) {
          const sanitizedName = feature.name.replace(/[^a-zA-Z0-9-_]/g, '_');
          const existingPath = path.join(feature.basePath, `CONTRACTS_${sanitizedName}.md`);
          try {
            await fs.access(existingPath);
            results.push({
              feature: feature.name,
              success: true,
              markdownPath: existingPath,
              jsonPath: path.join(repoPath, KANVAS_PATHS.baseDir, 'contracts', 'features', `${feature.name}.contracts.json`),
            });
            console.log(`[ContractGeneration] Skipping existing: ${feature.name}`);
            continue;
          } catch {
            // File doesn't exist, generate it
          }
        }

        // Generate contract
        const result = await this.generateFeatureContract(repoPath, feature, options);
        if (result.success && result.data) {
          results.push(result.data);
        } else {
          results.push({
            feature: feature.name,
            success: false,
            error: result.error?.message || 'Unknown error',
          });
        }
      }

      // Save generation metadata for future incremental runs
      const generatedFeatureNames = results.filter(r => r.success).map(r => r.feature);
      await this.saveGenerationMetadata(repoPath, {
        lastGeneratedAt: new Date().toISOString(),
        lastCommitHash: currentCommitHash,
        generatedFeatures: generatedFeatureNames,
        version: '1.0',
      });

      const duration = Date.now() - startTime;
      const skippedCount = isIncremental ? (features.length - featuresToProcess.length) :
        (options.skipExisting ? results.filter(r => r.success && !r.error).length : 0);

      const batchResult: BatchContractGenerationResult = {
        totalFeatures: features.length,
        generated: results.filter(r => r.success).length,
        skipped: skippedCount,
        failed: results.filter(r => !r.success).length,
        results,
        duration,
      };

      // Emit completion
      this.emitToRenderer(IPC.CONTRACT_GENERATION_COMPLETE, batchResult);
      console.log(`[ContractGeneration] Batch complete: ${batchResult.generated} generated, ${batchResult.skipped} skipped (unchanged), ${batchResult.failed} failed in ${duration}ms`);

      return batchResult;
    }, 'GENERATE_ALL_ERROR');
  }

  /**
   * Generate repo-level contracts (API, Infra, Third-Party, etc.)
   * These are aggregate contracts that cover the entire repository
   */
  async generateRepoContracts(
    repoPath: string,
    options: ContractGenerationOptions = {}
  ): Promise<IpcResult<{ generated: string[]; skipped: string[]; errors: string[] }>> {
    return this.wrap(async () => {
      const generated: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];

      // Repo-level contract definitions
      const repoContracts = [
        { type: 'api', file: 'API_CONTRACT.md', promptKey: 'generate_repo_api_contract', description: 'Aggregated API endpoints across all features' },
        { type: 'infra', file: 'INFRA_CONTRACT.md', promptKey: 'generate_infra_contract', description: 'Infrastructure, environment variables, and deployment config' },
        { type: 'integrations', file: 'THIRD_PARTY_INTEGRATIONS.md', promptKey: 'generate_third_party_contract', description: 'External service integrations and SDKs' },
        { type: 'schema', file: 'DATABASE_SCHEMA_CONTRACT.md', promptKey: 'generate_database_schema_contract', description: 'Database tables, schemas, and migrations' },
        { type: 'events', file: 'EVENTS_CONTRACT.md', promptKey: 'generate_events_contract', description: 'Event bus, WebSocket, and pub/sub events' },
        { type: 'admin', file: 'ADMIN_CONTRACT.md', promptKey: 'generate_admin_contract', description: 'Admin panel capabilities and permissions' },
        { type: 'sql', file: 'SQL_CONTRACT.md', promptKey: 'generate_sql_contract', description: 'Reusable SQL queries and stored procedures' },
      ];

      // Target directory for repo contracts
      const contractsDir = path.join(repoPath, 'House_Rules_Contracts');
      await fs.mkdir(contractsDir, { recursive: true });

      // Get repo structure for context
      const structureResult = await this.analyzeRepoStructure(repoPath);
      const repoStructure = structureResult.success ? structureResult.data : null;

      // Get discovered features for aggregation
      const featuresResult = await this.discoverFeatures(repoPath, options.useAI);
      const features = featuresResult.success ? featuresResult.data || [] : [];

      for (const contract of repoContracts) {
        const contractPath = path.join(contractsDir, contract.file);

        // Check if contract already exists
        if (options.skipExisting) {
          try {
            await fs.access(contractPath);
            skipped.push(contract.file);
            console.log(`[ContractGeneration] Skipped existing repo contract: ${contract.file}`);
            continue;
          } catch {
            // File doesn't exist, proceed with generation
          }
        }

        try {
          console.log(`[ContractGeneration] Generating repo contract: ${contract.file}`);

          // Build context from all features
          const featuresSummary = features.map(f => ({
            name: f.name,
            description: f.description || '',
            apiFiles: f.files.api.length,
            schemaFiles: f.files.schema.length,
            testFiles: f.files.tests.e2e.length + f.files.tests.unit.length + f.files.tests.integration.length,
          }));

          // Generate using AI
          const result = await this.aiService.sendWithMode({
            modeId: 'contract_generator',
            promptKey: contract.promptKey,
            variables: {
              repo_name: path.basename(repoPath),
              repo_structure: repoStructure ? JSON.stringify(repoStructure, null, 2) : 'Not available',
              features_summary: JSON.stringify(featuresSummary, null, 2),
              feature_count: features.length.toString(),
            },
            userMessage: `Generate a comprehensive ${contract.description} for this repository.`,
          });

          if (result.success && result.data) {
            // Clean up AI response - remove any "thinking" text
            const cleanedContent = this.cleanupAIResponse(result.data);

            // Get existing version and increment
            const jsonSidecarPath = contractPath.replace('.md', '.json');
            const existingVersion = await this.getExistingContractVersion(jsonSidecarPath);
            const newVersion = this.incrementVersion(existingVersion);

            // Add version header to markdown
            const versionHeader = `<!-- Version: ${newVersion} | Generated: ${new Date().toISOString()} -->\n\n`;
            const contentWithVersion = versionHeader + cleanedContent;
            await fs.writeFile(contractPath, contentWithVersion, 'utf-8');

            // Save JSON sidecar with version info
            const jsonSidecar = {
              type: contract.type,
              version: newVersion,
              lastGenerated: new Date().toISOString(),
              file: contract.file,
              description: contract.description,
            };
            await fs.writeFile(jsonSidecarPath, JSON.stringify(jsonSidecar, null, 2), 'utf-8');

            // Save to database for versioned history
            try {
              databaseService.saveContract({
                repoPath,
                contractType: contract.type,
                name: contract.file.replace('.md', ''),
                version: newVersion,
                content: contentWithVersion,
                jsonContent: JSON.stringify(jsonSidecar, null, 2),
                filePath: contractPath,
                isRepoLevel: true,
              });
              console.log(`[ContractGeneration] Saved to database v${newVersion}: ${contract.file}`);
            } catch (dbErr) {
              console.warn(`[ContractGeneration] Failed to save to database:`, dbErr);
            }

            generated.push(contract.file);
            console.log(`[ContractGeneration] Generated repo contract v${newVersion}: ${contract.file}`);
          } else {
            errors.push(`Failed to generate ${contract.file}: ${result.error?.message || 'Unknown error'}`);
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          errors.push(`Error generating ${contract.file}: ${errorMsg}`);
          console.error(`[ContractGeneration] Error generating ${contract.file}:`, err);
        }
      }

      return { generated, skipped, errors };
    }, 'GENERATE_REPO_CONTRACTS_ERROR');
  }

  /**
   * Generate a single contract by type
   * Used for generating individual missing contracts from the UI
   */
  async generateSingleContract(
    repoPath: string,
    contractType: string
  ): Promise<IpcResult<{ file: string; success: boolean; error?: string }>> {
    return this.wrap(async () => {
      // Contract definitions mapping - using repo-level prompts that accept repo_name, repo_structure, features_summary, feature_count
      const contractDefs: Record<string, { file: string; promptKey: string; description: string }> = {
        api: { file: 'API_CONTRACT.md', promptKey: 'generate_repo_api_contract', description: 'Aggregated API endpoints across all features' },
        infra: { file: 'INFRA_CONTRACT.md', promptKey: 'generate_repo_infra_contract', description: 'Infrastructure, environment variables, and deployment config' },
        integrations: { file: 'THIRD_PARTY_INTEGRATIONS.md', promptKey: 'generate_repo_third_party_contract', description: 'External service integrations and SDKs' },
        schema: { file: 'DATABASE_SCHEMA_CONTRACT.md', promptKey: 'generate_repo_database_schema_contract', description: 'Database tables, schemas, and migrations' },
        events: { file: 'EVENTS_CONTRACT.md', promptKey: 'generate_repo_events_contract', description: 'Event bus, WebSocket, and pub/sub events' },
        admin: { file: 'ADMIN_CONTRACT.md', promptKey: 'generate_repo_admin_contract', description: 'Admin panel capabilities and permissions' },
        sql: { file: 'SQL_CONTRACT.md', promptKey: 'generate_repo_sql_contract', description: 'Reusable SQL queries and stored procedures' },
        features: { file: 'FEATURES_CONTRACT.md', promptKey: 'generate_repo_features_contract', description: 'Feature flags and configuration' },
        css: { file: 'CSS_CONTRACT.md', promptKey: 'generate_repo_css_contract', description: 'Design tokens and CSS variables' },
        prompts: { file: 'PROMPTS_CONTRACT.md', promptKey: 'generate_repo_prompts_contract', description: 'AI prompts, skills, and agent configurations' },
      };

      const contractDef = contractDefs[contractType];
      if (!contractDef) {
        throw new Error(`Unknown contract type: ${contractType}`);
      }

      // Create contracts directory
      const contractsDir = path.join(repoPath, 'House_Rules_Contracts');
      await fs.mkdir(contractsDir, { recursive: true });

      const contractPath = path.join(contractsDir, contractDef.file);

      // Get repo structure for context
      const structureResult = await this.analyzeRepoStructure(repoPath);
      const repoStructure = structureResult.success ? structureResult.data : null;

      // Get discovered features for aggregation
      const featuresResult = await this.discoverFeatures(repoPath, false);
      const features = featuresResult.success ? featuresResult.data || [] : [];

      const featuresSummary = features.map(f => ({
        name: f.name,
        description: f.description || '',
        apiFiles: f.files.api.length,
        schemaFiles: f.files.schema.length,
        testFiles: f.files.tests.e2e.length + f.files.tests.unit.length + f.files.tests.integration.length,
      }));

      console.log(`[ContractGeneration] Generating single contract: ${contractDef.file} for type: ${contractType}`);
      console.log(`[ContractGeneration] Repo path: ${repoPath}`);
      console.log(`[ContractGeneration] Features found: ${features.length}`);

      // Extract additional data based on contract type
      let extractedData = '';

      // For schema/sql contracts, extract actual database schemas
      if ((contractType === 'schema' || contractType === 'sql') && this.schemaExtractor) {
        console.log(`[ContractGeneration] Extracting schema data for ${contractType} contract...`);
        try {
          const globSync = await getGlobSync();
          console.log(`[ContractGeneration] globSync available: ${!!globSync}`);
          if (globSync) {
            // Find schema-related files
            const schemaFiles = globSync('**/*.{ts,js,sql,prisma}', {
              cwd: repoPath,
              ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
              absolute: true,
            }).filter((f: string) =>
              f.includes('database') || f.includes('schema') || f.includes('model') ||
              f.includes('migration') || f.includes('Database') || f.includes('Schema') ||
              f.endsWith('.sql') || f.endsWith('.prisma')
            ).slice(0, 10); // Limit to 10 files

            console.log(`[ContractGeneration] Found ${schemaFiles.length} schema-related files:`, schemaFiles);

            if (schemaFiles.length > 0) {
              const schemas = await this.schemaExtractor.extractFromFiles(
                schemaFiles.map((p: string) => ({ path: p }))
              );
              console.log(`[ContractGeneration] Extracted ${schemas.length} schemas`);
              if (schemas.length > 0) {
                extractedData = `\n\nEXTRACTED SCHEMA DATA:\n${JSON.stringify(schemas, null, 2)}`;
              }
            }

            // Also include raw CREATE TABLE statements
            const dbServiceFile = schemaFiles.find((f: string) => f.includes('DatabaseService'));
            console.log(`[ContractGeneration] DatabaseService file: ${dbServiceFile || 'not found'}`);
            if (dbServiceFile) {
              const content = await fs.readFile(dbServiceFile, 'utf-8');
              const createTableMatches = content.match(/CREATE\s+TABLE[^;]+;/gi);
              console.log(`[ContractGeneration] Found ${createTableMatches?.length || 0} CREATE TABLE statements`);
              if (createTableMatches) {
                extractedData += `\n\nRAW SQL STATEMENTS FOUND:\n${createTableMatches.join('\n\n')}`;
              }
            }
          }
        } catch (err) {
          console.warn('[ContractGeneration] Schema extraction failed:', err);
        }
        console.log(`[ContractGeneration] Extracted data length: ${extractedData.length} chars`);
      }

      // For API contracts, extract actual endpoints
      if (contractType === 'api' && this.apiExtractor) {
        try {
          const globSync = await getGlobSync();
          if (globSync) {
            const apiFiles = globSync('**/*.{ts,js}', {
              cwd: repoPath,
              ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.test.*', '**/*.spec.*'],
              absolute: true,
            }).filter(f =>
              f.includes('route') || f.includes('controller') || f.includes('api') ||
              f.includes('handler') || f.includes('ipc') || f.includes('Route') ||
              f.includes('Controller') || f.includes('Handler')
            ).slice(0, 15);

            if (apiFiles.length > 0) {
              const endpoints = await this.apiExtractor.extractFromFiles(
                apiFiles.map(p => ({ path: p }))
              );
              if (endpoints.length > 0) {
                extractedData = `\n\nEXTRACTED API ENDPOINTS:\n${JSON.stringify(endpoints, null, 2)}`;
              }
            }
          }
        } catch (err) {
          console.warn('[ContractGeneration] API extraction failed:', err);
        }
      }

      // For prompts/skills contracts, scan config/modes directory
      if (contractType === 'prompts') {
        try {
          const globSync = await getGlobSync();
          if (globSync) {
            const configFiles = globSync('**/*.{yaml,yml,json}', {
              cwd: repoPath,
              ignore: ['**/node_modules/**', '**/dist/**'],
              absolute: true,
            }).filter(f =>
              f.includes('mode') || f.includes('prompt') || f.includes('skill') ||
              f.includes('config') || f.includes('agent')
            ).slice(0, 10);

            if (configFiles.length > 0) {
              const configData: string[] = [];
              for (const file of configFiles) {
                try {
                  const content = await fs.readFile(file, 'utf-8');
                  configData.push(`\n--- ${path.relative(repoPath, file)} ---\n${content.slice(0, 2000)}`);
                } catch {}
              }
              if (configData.length > 0) {
                extractedData = `\n\nCONFIG FILES FOUND:\n${configData.join('\n')}`;
              }
            }
          }
        } catch (err) {
          console.warn('[ContractGeneration] Config extraction failed:', err);
        }
      }

      // For infra contracts, look for env files and docker configs
      if (contractType === 'infra') {
        try {
          const globSync = await getGlobSync();
          if (globSync) {
            // Prioritize docker-compose files first as they contain the most useful infra info
            const dockerComposeFiles = globSync('**/docker-compose*.{yml,yaml}', {
              cwd: repoPath,
              ignore: ['**/node_modules/**', '**/backups/**'],
              absolute: true,
            }).slice(0, 3);

            const otherInfraFiles = globSync('**/{.env.example,.env.sample,Dockerfile,*.dockerfile,k8s*.yml,k8s*.yaml}', {
              cwd: repoPath,
              ignore: ['**/node_modules/**', '**/backups/**'],
              absolute: true,
              dot: true,
            }).slice(0, 5);

            const infraFiles = [...dockerComposeFiles, ...otherInfraFiles];

            if (infraFiles.length > 0) {
              const infraData: string[] = [];
              for (const file of infraFiles) {
                try {
                  const content = await fs.readFile(file, 'utf-8');
                  const fileName = path.relative(repoPath, file);
                  // Allow full content for docker-compose (up to 15000 chars), limit others
                  const maxChars = fileName.includes('docker-compose') ? 15000 : 3000;
                  infraData.push(`\n--- ${fileName} ---\n${content.slice(0, maxChars)}`);
                } catch {}
              }
              if (infraData.length > 0) {
                extractedData = `\n\nINFRASTRUCTURE FILES FOUND:\n${infraData.join('\n')}`;
                console.log(`[ContractGeneration] Extracted ${infraFiles.length} infra files, total length: ${extractedData.length}`);
              }
            }
          }
        } catch (err) {
          console.warn('[ContractGeneration] Infra extraction failed:', err);
        }
      }

      // For integrations contract, extract from package.json and find API calls
      if (contractType === 'integrations') {
        try {
          const integrationData: string[] = [];

          // Read package.json for dependencies
          const packageJsonPath = path.join(repoPath, 'package.json');
          try {
            const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
            const pkg = JSON.parse(packageContent);
            const allDeps = {
              ...pkg.dependencies || {},
              ...pkg.devDependencies || {}
            };

            // Identify third-party SDK/API packages
            const thirdPartyIndicators = ['@aws-sdk', '@google', '@azure', 'stripe', 'twilio', 'sendgrid',
              'firebase', 'redis', 'mongodb', 'postgres', 'mysql', 'kafka', 'neo4j', 'axios', 'node-fetch',
              'groq', 'openai', 'anthropic', 'weaviate', 'pinecone', 'minio', 'kong'];

            const thirdPartyDeps: Record<string, string> = {};
            for (const [name, version] of Object.entries(allDeps)) {
              if (thirdPartyIndicators.some(indicator => name.includes(indicator))) {
                thirdPartyDeps[name] = version as string;
              }
            }

            if (Object.keys(thirdPartyDeps).length > 0) {
              integrationData.push(`\n--- Third-Party Dependencies (from package.json) ---\n${JSON.stringify(thirdPartyDeps, null, 2)}`);
            }
          } catch {}

          // Also check docker-compose for external services
          const globSync = await getGlobSync();
          if (globSync) {
            const dockerComposeFiles = globSync('**/docker-compose*.{yml,yaml}', {
              cwd: repoPath,
              ignore: ['**/node_modules/**', '**/backups/**'],
              absolute: true,
            }).slice(0, 2);

            for (const file of dockerComposeFiles) {
              try {
                const content = await fs.readFile(file, 'utf-8');
                // Extract service names and images from docker-compose
                const serviceMatches = content.match(/^\s{2}[\w-]+:\s*$/gm) || [];
                const imageMatches = content.match(/image:\s*[\w\/:.-]+/g) || [];
                if (serviceMatches.length > 0 || imageMatches.length > 0) {
                  integrationData.push(`\n--- Docker Services (from ${path.relative(repoPath, file)}) ---\nServices: ${serviceMatches.map(s => s.trim().replace(':', '')).join(', ')}\nImages: ${imageMatches.map(i => i.replace('image:', '').trim()).join(', ')}`);
                }
              } catch {}
            }
          }

          if (integrationData.length > 0) {
            extractedData = `\n\nINTEGRATIONS DATA FOUND:\n${integrationData.join('\n')}`;
            console.log(`[ContractGeneration] Extracted integrations data, length: ${extractedData.length}`);
          }
        } catch (err) {
          console.warn('[ContractGeneration] Integrations extraction failed:', err);
        }
      }

      // For features contract, enhance with actual feature code excerpts
      if (contractType === 'features' && features.length > 0) {
        try {
          const featureData: string[] = [];

          // Include detailed feature info
          for (const feature of features.slice(0, 10)) {
            const featureInfo = {
              name: feature.name,
              description: feature.description || 'No description',
              paths: feature.basePath ? [feature.basePath] : [],
              apiFiles: feature.files?.api?.slice(0, 5) || [],
              schemaFiles: feature.files?.schema?.slice(0, 5) || [],
              hasTests: (feature.files?.tests?.e2e?.length || 0) + (feature.files?.tests?.unit?.length || 0) > 0
            };
            featureData.push(`Feature: ${featureInfo.name}\n  Paths: ${featureInfo.paths.join(', ')}\n  API Files: ${featureInfo.apiFiles.length}\n  Schema Files: ${featureInfo.schemaFiles.length}\n  Has Tests: ${featureInfo.hasTests}`);
          }

          if (featureData.length > 0) {
            extractedData = `\n\nFEATURE DETAILS:\n${featureData.join('\n\n')}`;
            console.log(`[ContractGeneration] Extracted ${features.length} features data`);
          }
        } catch (err) {
          console.warn('[ContractGeneration] Features extraction failed:', err);
        }
      }

      // Generate using AI with extracted data
      const result = await this.aiService.sendWithMode({
        modeId: 'contract_generator',
        promptKey: contractDef.promptKey,
        variables: {
          repo_name: path.basename(repoPath),
          repo_structure: repoStructure ? JSON.stringify(repoStructure, null, 2) : 'Not available',
          features_summary: JSON.stringify(featuresSummary, null, 2),
          feature_count: features.length.toString(),
        },
        userMessage: `Generate a comprehensive ${contractDef.description} for this repository.

IMPORTANT: Use the ACTUAL data provided below. Do NOT generate placeholder text like "[table_name]" or "[Feature Name]".
If no relevant data is found, state "No ${contractType} data detected in this repository."
${extractedData}`,
      });

      console.log(`[ContractGeneration] AI result success: ${result.success}, has data: ${!!result.data}`);
      if (result.success && result.data) {
        console.log(`[ContractGeneration] AI response length: ${result.data.length} chars`);
        console.log(`[ContractGeneration] AI response preview: ${result.data.substring(0, 200)}...`);

        // Clean up AI response
        const cleanedContent = this.cleanupAIResponse(result.data);

        // Get existing version and increment
        const jsonSidecarPath = contractPath.replace('.md', '.json');
        const existingVersion = await this.getExistingContractVersion(jsonSidecarPath);
        const newVersion = this.incrementVersion(existingVersion);

        // Add version header
        const versionHeader = `<!-- Version: ${newVersion} | Generated: ${new Date().toISOString()} -->\n\n`;
        const contentWithVersion = versionHeader + cleanedContent;

        console.log(`[ContractGeneration] Writing to: ${contractPath}`);
        await fs.writeFile(contractPath, contentWithVersion, 'utf-8');
        console.log(`[ContractGeneration] File written successfully`);

        // Save JSON sidecar
        const jsonSidecar = {
          type: contractType,
          version: newVersion,
          lastGenerated: new Date().toISOString(),
          file: contractDef.file,
          description: contractDef.description,
        };
        await fs.writeFile(jsonSidecarPath, JSON.stringify(jsonSidecar, null, 2), 'utf-8');

        // Save to database
        try {
          databaseService.saveContract({
            repoPath,
            contractType,
            name: contractDef.file.replace('.md', ''),
            version: newVersion,
            content: contentWithVersion,
            jsonContent: JSON.stringify(jsonSidecar, null, 2),
            filePath: contractPath,
            isRepoLevel: true,
          });
        } catch (dbErr) {
          console.warn('[ContractGeneration] Failed to save to database:', dbErr);
        }

        console.log(`[ContractGeneration] Successfully generated: ${contractDef.file}`);
        return { file: contractDef.file, success: true };
      } else {
        const errorMsg = result.error?.message || 'Unknown error';
        console.error(`[ContractGeneration] Failed to generate ${contractDef.file}:`, errorMsg);
        if (result.error) {
          console.error(`[ContractGeneration] Full error:`, result.error);
        }
        return { file: contractDef.file, success: false, error: errorMsg };
      }
    }, 'GENERATE_SINGLE_CONTRACT_ERROR');
  }

  /**
   * Generate all contracts (both repo-level and feature-level)
   * Convenience method that runs both repo and feature contract generation
   */
  async generateAllContractsComplete(
    repoPath: string,
    options: ContractGenerationOptions = {}
  ): Promise<IpcResult<{ repoContracts: { generated: string[]; skipped: string[]; errors: string[] }; featureContracts: BatchContractGenerationResult }>> {
    return this.wrap(async () => {
      // First generate repo-level contracts
      console.log('[ContractGeneration] Starting complete contract generation...');

      const repoResult = await this.generateRepoContracts(repoPath, options);
      const repoContracts = repoResult.success ? repoResult.data! : { generated: [], skipped: [], errors: [repoResult.error?.message || 'Unknown error'] };

      // Then generate feature-level contracts
      const featureResult = await this.generateAllContracts(repoPath, options);
      const featureContracts = featureResult.success ? featureResult.data! : {
        totalFeatures: 0,
        generated: 0,
        skipped: 0,
        failed: 1,
        results: [],
        duration: 0,
      };

      return { repoContracts, featureContracts };
    }, 'GENERATE_ALL_COMPLETE_ERROR');
  }

  /**
   * Emit progress event to renderer
   */
  private emitProgress(progress: ContractGenerationProgress): void {
    this.currentProgress = progress;
    this.emitToRenderer(IPC.CONTRACT_GENERATION_PROGRESS, progress);
  }

  /**
   * Cancel ongoing generation
   */
  cancelGeneration(): void {
    this.isCancelled = true;
    console.log('[ContractGeneration] Cancel requested');
  }

  /**
   * Get current generation progress
   */
  getProgress(): ContractGenerationProgress | null {
    return this.currentProgress;
  }
}
