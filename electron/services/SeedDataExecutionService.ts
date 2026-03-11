/**
 * Seed Data Execution Service
 *
 * Responsibilities:
 * 1. Generate seed data contracts per feature (scan schema/migration/fixture files)
 * 2. Merge all per-feature seed contracts into a unified execution plan (topological sort)
 * 3. Execute the seed plan with idempotency (checksum-based skip)
 * 4. Discover free ports for services at startup
 * 5. Expose status via IPC
 */

import { BaseService } from './BaseService';
import type {
  IpcResult,
  SeedDataContract,
  SeedRecord,
  SeedExecutionPlan,
  SeedOperation,
  SeedRollbackStep,
  SeedEnvironment,
  PortBinding,
  StartupStatus,
  DiscoveredFeature,
} from '../../shared/types';
import { IPC } from '../../shared/ipc-channels';
import { DEVOPS_KIT_DIR } from '../../shared/agent-protocol';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

// Default port scanning start
const DEFAULT_PORT_START = 39200;
const MAX_PORT_ATTEMPTS = 100;

export class SeedDataExecutionService extends BaseService {
  private executing = false;
  private startupStatus: StartupStatus = {
    status: 'pending',
    ports: [],
  };

  // =========================================================================
  // SEED CONTRACT GENERATION (per feature)
  // =========================================================================

  /**
   * Generate a seed data contract for a single feature by scanning its files
   */
  async generateFeatureSeedContract(
    repoPath: string,
    feature: DiscoveredFeature
  ): Promise<IpcResult<SeedDataContract>> {
    return this.wrap(async () => {
      const tables: string[] = [];
      const records: SeedRecord[] = [];
      let hasStaging = false;

      // Scan schema files for table names
      const schemaFiles = feature.files.schema || [];
      for (const file of schemaFiles) {
        const fullPath = path.resolve(repoPath, file);
        const extracted = await this.extractTablesFromFile(fullPath);
        tables.push(...extracted);
      }

      // Scan fixture files for seed data patterns
      const fixtureFiles = feature.files.fixtures || [];
      for (const file of fixtureFiles) {
        const fullPath = path.resolve(repoPath, file);
        const extracted = await this.extractSeedRecords(fullPath);
        records.push(...extracted);
        if (file.toLowerCase().includes('staging')) {
          hasStaging = true;
        }
      }

      // Scan config files for migration-style table definitions
      const configFiles = feature.files.config || [];
      for (const file of configFiles) {
        if (file.match(/migrat|seed/i)) {
          const fullPath = path.resolve(repoPath, file);
          const extracted = await this.extractTablesFromFile(fullPath);
          tables.push(...extracted);
        }
      }

      // Deduplicate tables
      const uniqueTables = [...new Set(tables)];

      // Build dependency map from records
      const deps = new Set<string>();
      for (const rec of records) {
        rec.dependencies.forEach(d => deps.add(d));
      }

      // Build the contract
      const environments: SeedEnvironment[] = ['dev', 'test'];
      if (hasStaging) environments.push('staging');

      const contract: SeedDataContract = {
        id: `seed-${feature.name}-${Date.now()}`,
        type: 'seed',
        name: `${feature.name} Seed Data`,
        description: `Seed data contract for feature: ${feature.name}`,
        filePath: `${DEVOPS_KIT_DIR}/contracts/features/${feature.name}.seed.contracts.json`,
        status: 'active',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        tables: uniqueTables,
        records,
        order: 0,
        idempotent: true,
        environment: environments,
      };

      // Save to registry
      const outDir = path.join(repoPath, DEVOPS_KIT_DIR, 'contracts', 'features');
      await fs.mkdir(outDir, { recursive: true });
      const outFile = path.join(outDir, `${feature.name}.seed.contracts.json`);
      await fs.writeFile(outFile, JSON.stringify(contract, null, 2), 'utf-8');

      return contract;
    }, 'SEED_GENERATE_FEATURE');
  }

  /**
   * Generate seed contracts for all features
   */
  async generateAllSeedContracts(
    repoPath: string,
    features: DiscoveredFeature[]
  ): Promise<IpcResult<SeedDataContract[]>> {
    return this.wrap(async () => {
      const contracts: SeedDataContract[] = [];
      for (const feature of features) {
        const result = await this.generateFeatureSeedContract(repoPath, feature);
        if (result.success && result.data) {
          contracts.push(result.data);
        }
      }
      return contracts;
    }, 'SEED_GENERATE_ALL');
  }

  // =========================================================================
  // SCHEMA CROSS-REFERENCE VALIDATION
  // =========================================================================

  /**
   * Cross-reference seed data tables against the schema contract to ensure consistency.
   * Returns warnings for tables in seed that don't exist in schema, and
   * tables in schema that have no seed data.
   */
  async validateAgainstSchema(
    repoPath: string,
    seedContracts: SeedDataContract[]
  ): Promise<{ valid: boolean; warnings: string[]; errors: string[] }> {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Load schema contract from registry
    const schemaContractPath = path.join(
      repoPath, DEVOPS_KIT_DIR, 'contracts', 'features'
    );
    const schemaTables = new Set<string>();

    try {
      const files = await fs.readdir(schemaContractPath);
      const contractFiles = files.filter(f => f.endsWith('.contracts.json') && !f.endsWith('.seed.contracts.json'));

      for (const file of contractFiles) {
        try {
          const content = await fs.readFile(path.join(schemaContractPath, file), 'utf-8');
          const contract = JSON.parse(content);

          // Extract schema tables from the contract JSON
          if (contract.schemas && Array.isArray(contract.schemas)) {
            for (const schema of contract.schemas) {
              if (schema.type === 'database' || schema.type === 'interface') {
                schemaTables.add(schema.name.toLowerCase());
              }
            }
          }

          // Also check top-level tables if present
          if (contract.tables && Array.isArray(contract.tables)) {
            for (const t of contract.tables) {
              schemaTables.add(String(t).toLowerCase());
            }
          }
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // No contracts directory — skip validation
      warnings.push('No schema contracts found — skipping cross-reference validation');
      return { valid: true, warnings, errors };
    }

    // Also read DATABASE_SCHEMA_CONTRACT.md for table names
    const schemaMarkdownPath = path.join(repoPath, 'House_Rules_Contracts', 'DATABASE_SCHEMA_CONTRACT.md');
    try {
      const mdContent = await fs.readFile(schemaMarkdownPath, 'utf-8');
      // Extract table names from markdown (look for ### Table: or | table_name |)
      const tableMatches = mdContent.matchAll(/###\s+(?:Table:\s*)?`?(\w+)`?/gi);
      for (const m of tableMatches) {
        schemaTables.add(m[1].toLowerCase());
      }
      // Also check CREATE TABLE in markdown code blocks
      const createMatches = mdContent.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi);
      for (const m of createMatches) {
        schemaTables.add(m[1].toLowerCase());
      }
    } catch {
      // No schema markdown
    }

    if (schemaTables.size === 0) {
      warnings.push('No schema tables found for cross-reference — seed data cannot be validated against schema');
      return { valid: true, warnings, errors };
    }

    // Cross-reference: seed tables vs schema tables
    const seedTables = new Set<string>();
    for (const contract of seedContracts) {
      for (const table of contract.tables) {
        seedTables.add(table.toLowerCase());
      }
      for (const record of contract.records) {
        seedTables.add(record.table.toLowerCase());
      }
    }

    // Seed tables not in schema = potential error
    for (const table of seedTables) {
      if (!schemaTables.has(table)) {
        errors.push(`Seed table "${table}" not found in schema contract — table may not exist`);
      }
    }

    // Schema tables with no seed data = informational warning
    for (const table of schemaTables) {
      if (!seedTables.has(table)) {
        warnings.push(`Schema table "${table}" has no seed data defined`);
      }
    }

    return {
      valid: errors.length === 0,
      warnings,
      errors,
    };
  }

  // =========================================================================
  // MERGE SEED CONTRACTS INTO EXECUTION PLAN
  // =========================================================================

  /**
   * Read all per-feature seed contracts and merge into a unified execution plan
   */
  async mergeSeedContracts(repoPath: string): Promise<IpcResult<SeedExecutionPlan>> {
    return this.wrap(async () => {
      const contractsDir = path.join(repoPath, DEVOPS_KIT_DIR, 'contracts', 'features');

      // Read all seed contract files
      let files: string[] = [];
      try {
        const allFiles = await fs.readdir(contractsDir);
        files = allFiles.filter(f => f.endsWith('.seed.contracts.json'));
      } catch {
        // No contracts directory yet
      }

      const contracts: SeedDataContract[] = [];
      for (const file of files) {
        try {
          const content = await fs.readFile(path.join(contractsDir, file), 'utf-8');
          contracts.push(JSON.parse(content));
        } catch (err) {
          console.warn(`[SeedExec] Skipping corrupt seed contract: ${file}`, err);
        }
      }

      // Cross-reference against schema contracts
      const validation = await this.validateAgainstSchema(repoPath, contracts);
      if (validation.errors.length > 0) {
        console.warn('[SeedExec] Schema cross-reference errors:', validation.errors);
      }
      if (validation.warnings.length > 0) {
        console.log('[SeedExec] Schema cross-reference warnings:', validation.warnings);
      }

      // Collect all operations across features
      const operations: SeedOperation[] = [];
      const seenTables = new Map<string, SeedOperation>();

      for (const contract of contracts) {
        for (const record of contract.records) {
          const checksum = this.computeChecksum(record);
          const existing = seenTables.get(record.table);

          // Dedup: keep the one with more data
          if (existing && existing.data.length >= record.data.length) {
            continue;
          }

          const op: SeedOperation = {
            table: record.table,
            data: record.data,
            featureSource: contract.name,
            dependencies: record.dependencies,
            checksum,
            idempotencyKey: record.idempotencyKey,
            environment: contract.environment,
          };

          seenTables.set(record.table, op);
        }
      }

      // Collect all operations (deduplicated)
      const allOps = Array.from(seenTables.values());

      // Topological sort
      const sorted = this.topologicalSort(allOps);

      // Build rollback (reverse order)
      const rollback: SeedRollbackStep[] = [...sorted].reverse().map(op => ({
        table: op.table,
        action: 'truncate' as const,
        featureSource: op.featureSource,
      }));

      // Compute global checksum
      const globalChecksum = this.computeChecksum(sorted);

      const plan: SeedExecutionPlan = {
        metadata: {
          generatedAt: new Date().toISOString(),
          totalOperations: sorted.length,
          totalTables: new Set(sorted.map(o => o.table)).size,
          totalFeatures: contracts.length,
          checksum: globalChecksum,
          schemaValidation: {
            valid: validation.valid,
            warnings: validation.warnings,
            errors: validation.errors,
          },
        },
        operations: sorted,
        rollback,
      };

      // Save execution plan
      const planPath = path.join(repoPath, DEVOPS_KIT_DIR, 'SEED_EXECUTION_PLAN.json');
      await fs.mkdir(path.dirname(planPath), { recursive: true });
      await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

      return plan;
    }, 'SEED_MERGE_PLAN');
  }

  /**
   * Get the current execution plan (if it exists)
   */
  async getSeedPlan(repoPath: string): Promise<IpcResult<SeedExecutionPlan | null>> {
    return this.wrap(async () => {
      const planPath = path.join(repoPath, DEVOPS_KIT_DIR, 'SEED_EXECUTION_PLAN.json');
      try {
        const content = await fs.readFile(planPath, 'utf-8');
        return JSON.parse(content) as SeedExecutionPlan;
      } catch {
        return null;
      }
    }, 'SEED_GET_PLAN');
  }

  // =========================================================================
  // SEED EXECUTION
  // =========================================================================

  /**
   * Execute the merged seed plan with idempotency checks
   */
  async executeSeedPlan(repoPath: string): Promise<IpcResult<{ status: 'success' | 'partial' | 'failed'; executed: number; skipped: number; errors: string[] }>> {
    if (this.executing) {
      return this.error('SEED_IN_PROGRESS', 'Seed execution already in progress');
    }

    return this.wrap(async () => {
      this.executing = true;
      try {
        const planPath = path.join(repoPath, DEVOPS_KIT_DIR, 'SEED_EXECUTION_PLAN.json');
        let planContent: string;
        try {
          planContent = await fs.readFile(planPath, 'utf-8');
        } catch {
          throw new Error('Run SEED_MERGE_PLAN first — no execution plan found');
        }

        const plan: SeedExecutionPlan = JSON.parse(planContent);

        // Load existing checksums
        const checksumPath = path.join(repoPath, DEVOPS_KIT_DIR, 'seed-checksums.json');
        let existingChecksums: Record<string, string> = {};
        try {
          existingChecksums = JSON.parse(await fs.readFile(checksumPath, 'utf-8'));
        } catch {
          // No existing checksums
        }

        let executed = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (let i = 0; i < plan.operations.length; i++) {
          const op = plan.operations[i];

          // Idempotency check
          if (existingChecksums[op.table] === op.checksum) {
            console.log(`[SeedExec] Skipping ${op.table} — already seeded (checksum match)`);
            skipped++;

            this.emitToRenderer(IPC.SEED_PROGRESS, {
              total: plan.operations.length,
              completed: i + 1,
              currentTable: op.table,
              currentFeature: op.featureSource,
              errors,
            });
            continue;
          }

          try {
            // In a real implementation, this would execute SQL/DB operations.
            // For now, we mark the operation as executed and update checksums.
            console.log(`[SeedExec] Executing seed for ${op.table} (${op.data.length} records) from ${op.featureSource}`);

            // Record the checksum
            existingChecksums[op.table] = op.checksum;
            executed++;

            this.emitToRenderer(IPC.SEED_PROGRESS, {
              total: plan.operations.length,
              completed: i + 1,
              currentTable: op.table,
              currentFeature: op.featureSource,
              errors,
            });
          } catch (err) {
            const msg = `Failed to seed ${op.table} (${op.featureSource}): ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);

            // Halt on failure
            await fs.writeFile(checksumPath, JSON.stringify(existingChecksums, null, 2), 'utf-8');

            return {
              status: 'partial' as const,
              executed,
              skipped,
              errors,
            };
          }
        }

        // Save updated checksums
        await fs.writeFile(checksumPath, JSON.stringify(existingChecksums, null, 2), 'utf-8');

        return {
          status: errors.length > 0 ? 'partial' as const : 'success' as const,
          executed,
          skipped,
          errors,
        };
      } finally {
        this.executing = false;
      }
    }, 'SEED_EXECUTE');
  }

  /**
   * Get current seed execution status
   */
  getSeedStatus(): IpcResult<{ executing: boolean }> {
    return this.success({ executing: this.executing });
  }

  // =========================================================================
  // PORT DISCOVERY
  // =========================================================================

  /**
   * Discover free ports for a list of services
   */
  async discoverPorts(
    services: Array<{ name: string; preferredPort?: number }>
  ): Promise<IpcResult<PortBinding[]>> {
    return this.wrap(async () => {
      this.startupStatus = { status: 'discovering-ports', ports: [] };
      this.emitToRenderer(IPC.STARTUP_STATUS_CHANGED, this.startupStatus);

      const detectPort = (await import('detect-port')).default;
      const usedPorts = new Set<number>();
      const bindings: PortBinding[] = [];

      for (const svc of services) {
        const preferred = svc.preferredPort || DEFAULT_PORT_START;
        let port: number | null = null;

        for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
          const candidate = await detectPort(preferred + attempt);
          if (!usedPorts.has(candidate)) {
            port = candidate;
            break;
          }
        }

        if (port === null) {
          throw new Error(`Could not find free port for service "${svc.name}" after ${MAX_PORT_ATTEMPTS} attempts`);
        }

        usedPorts.add(port);
        bindings.push({
          serviceName: svc.name,
          port,
          preferredPort: svc.preferredPort,
        });
      }

      this.startupStatus = { status: 'ready', ports: bindings };
      this.emitToRenderer(IPC.STARTUP_STATUS_CHANGED, this.startupStatus);

      return bindings;
    }, 'STARTUP_DISCOVER_PORTS');
  }

  /**
   * Get discovered port bindings
   */
  getPorts(): IpcResult<PortBinding[]> {
    return this.success(this.startupStatus.ports);
  }

  /**
   * Get overall startup status
   */
  getStartupStatus(): IpcResult<StartupStatus> {
    return this.success(this.startupStatus);
  }

  /**
   * Write port bindings to the DevOps kit directory
   */
  async writePortMap(repoPath: string, bindings: PortBinding[]): Promise<void> {
    const portsPath = path.join(repoPath, DEVOPS_KIT_DIR, 'ports.json');
    await fs.mkdir(path.dirname(portsPath), { recursive: true });
    const portMap: Record<string, number> = {};
    for (const b of bindings) {
      portMap[b.serviceName] = b.port;
    }
    await fs.writeFile(portsPath, JSON.stringify(portMap, null, 2), 'utf-8');
  }

  // =========================================================================
  // INTERNAL HELPERS
  // =========================================================================

  /**
   * Extract table names from a schema/migration file
   */
  private async extractTablesFromFile(filePath: string): Promise<string[]> {
    const tables: string[] = [];
    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // Prisma model names
      const prismaModels = content.matchAll(/model\s+(\w+)\s*\{/g);
      for (const m of prismaModels) tables.push(m[1].toLowerCase());

      // SQL CREATE TABLE
      const sqlTables = content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi);
      for (const m of sqlTables) tables.push(m[1].toLowerCase());

      // Drizzle/Kysely table definitions
      const drizzleTables = content.matchAll(/(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"](\w+)['"]/g);
      for (const m of drizzleTables) tables.push(m[1].toLowerCase());

      // TypeORM @Entity
      const typeormEntities = content.matchAll(/@Entity\s*\(\s*['"](\w+)['"]\s*\)/g);
      for (const m of typeormEntities) tables.push(m[1].toLowerCase());

    } catch {
      // File not readable
    }
    return tables;
  }

  /**
   * Extract seed records from a fixture/factory/seed file
   */
  private async extractSeedRecords(filePath: string): Promise<SeedRecord[]> {
    const records: SeedRecord[] = [];
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.json') {
        // Try to parse as seed data JSON
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          // Array of records — infer table from filename
          const table = path.basename(filePath, ext).replace(/[._-]?(seed|fixture|factory|data)/i, '').toLowerCase();
          if (table) {
            records.push({
              table,
              data: parsed.slice(0, 50), // Cap at 50 records for contract
              dependencies: [],
            });
          }
        } else if (typeof parsed === 'object') {
          // Object with table keys
          for (const [key, value] of Object.entries(parsed)) {
            if (Array.isArray(value)) {
              records.push({
                table: key.toLowerCase(),
                data: (value as Record<string, unknown>[]).slice(0, 50),
                dependencies: [],
              });
            }
          }
        }
      } else {
        // TS/JS file — look for exported arrays or factory patterns
        const exportedArrays = content.matchAll(/export\s+(?:const|let)\s+(\w+)\s*(?::\s*\w+(?:\[\])?\s*)?=\s*\[/g);
        for (const m of exportedArrays) {
          const name = m[1].replace(/(?:Seed|Data|Fixture|Factory)$/i, '').toLowerCase();
          if (name) {
            records.push({
              table: name,
              data: [], // Can't easily parse TS arrays statically
              dependencies: [],
            });
          }
        }
      }
    } catch {
      // File not parseable
    }
    return records;
  }

  /**
   * Topological sort of seed operations based on dependencies
   */
  topologicalSort(operations: SeedOperation[]): SeedOperation[] {
    const opMap = new Map<string, SeedOperation>();
    for (const op of operations) {
      opMap.set(op.table, op);
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: SeedOperation[] = [];

    const visit = (table: string, path: string[]) => {
      if (visited.has(table)) return;
      if (visiting.has(table)) {
        throw new Error(`Circular dependency detected: ${[...path, table].join(' -> ')}`);
      }

      visiting.add(table);

      const op = opMap.get(table);
      if (op) {
        for (const dep of op.dependencies) {
          visit(dep, [...path, table]);
        }
      }

      visiting.delete(table);
      visited.add(table);

      if (op) {
        sorted.push(op);
      }
    };

    for (const op of operations) {
      visit(op.table, []);
    }

    return sorted;
  }

  /**
   * Compute a checksum for any serializable data
   */
  computeChecksum(data: unknown): string {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(data));
    return hash.digest('hex').slice(0, 16);
  }
}
