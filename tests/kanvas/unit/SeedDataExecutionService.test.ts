/**
 * Unit tests for SeedDataExecutionService
 * Covers: seed contract generation, merge/topological sort, port discovery,
 *         execution with idempotency, schema cross-reference validation
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock electron BrowserWindow (BaseService depends on it)
jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
}));

// Mock fs.promises
jest.mock('fs', () => {
  const actual = jest.requireActual('fs') as any;
  return {
    ...actual,
    promises: {
      readFile: jest.fn(),
      writeFile: jest.fn(),
      readdir: jest.fn(),
      mkdir: jest.fn(),
    },
  };
});

// Mock detect-port
jest.mock('detect-port', () => ({
  __esModule: true,
  default: jest.fn((port: number) => Promise.resolve(port)),
}));

import { promises as fs } from 'fs';
import { SeedDataExecutionService } from '../../../electron/services/SeedDataExecutionService';
import type {
  SeedOperation,
  SeedDataContract,
  DiscoveredFeature,
  SeedExecutionPlan,
} from '../../../shared/types';

const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
const mockReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;
const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;

describe('SeedDataExecutionService', () => {
  let service: SeedDataExecutionService;

  beforeEach(() => {
    service = new SeedDataExecutionService();
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined as any);
    mockWriteFile.mockResolvedValue(undefined);
  });

  // =========================================================================
  // T1: Type validation
  // =========================================================================
  describe('T1: SeedDataContract type validation', () => {
    it('T1.1: creates a valid SeedDataContract with all required fields', () => {
      const contract: SeedDataContract = {
        id: 'seed-test-1',
        type: 'seed',
        name: 'Test Seed',
        filePath: '/test/path',
        status: 'active',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        tables: ['users', 'posts'],
        records: [
          { table: 'users', data: [{ id: '1', name: 'Admin' }], dependencies: [] },
        ],
        order: 0,
        idempotent: true,
        environment: ['dev', 'test'],
      };
      expect(contract.type).toBe('seed');
      expect(contract.tables).toHaveLength(2);
      expect(contract.records).toHaveLength(1);
    });
  });

  // =========================================================================
  // T2: Per-feature seed generation
  // =========================================================================
  describe('T2: Per-feature seed generation', () => {
    const makeFeature = (overrides: Partial<DiscoveredFeature> = {}): DiscoveredFeature => ({
      name: 'auth',
      basePath: '/repo/src/auth',
      files: {
        api: [],
        schema: [],
        tests: { e2e: [], unit: [], integration: [] },
        fixtures: [],
        config: [],
        css: [],
        prompts: [],
        other: [],
      },
      contractPatternMatches: 0,
      ...overrides,
    });

    it('T2.1: generates seed from Prisma schema with table extraction', async () => {
      const prismaContent = `
model User {
  id    String @id
  posts Post[]
}
model Post {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])
}
`;
      mockReadFile.mockResolvedValue(prismaContent as any);

      const feature = makeFeature({
        name: 'blog',
        files: {
          api: [], schema: ['src/blog/schema.prisma'], tests: { e2e: [], unit: [], integration: [] },
          fixtures: [], config: [], css: [], prompts: [], other: [],
        },
      });

      const result = await service.generateFeatureSeedContract('/repo', feature);
      expect(result.success).toBe(true);
      expect(result.data!.tables).toContain('user');
      expect(result.data!.tables).toContain('post');
    });

    it('T2.2: returns empty seed for feature with no schema/fixture files', async () => {
      const feature = makeFeature({ name: 'empty-feature' });

      const result = await service.generateFeatureSeedContract('/repo', feature);
      expect(result.success).toBe(true);
      expect(result.data!.tables).toHaveLength(0);
      expect(result.data!.records).toHaveLength(0);
    });

    it('T2.3: extracts data from JSON fixture files', async () => {
      mockReadFile.mockImplementation(async (filePath: any) => {
        if (String(filePath).includes('users')) {
          return JSON.stringify([
            { id: '1', name: 'Admin', email: 'admin@test.com' },
            { id: '2', name: 'User', email: 'user@test.com' },
          ]) as any;
        }
        return '' as any;
      });

      const feature = makeFeature({
        name: 'user-mgmt',
        files: {
          api: [], schema: [], tests: { e2e: [], unit: [], integration: [] },
          fixtures: ['fixtures/users.seed.json'], config: [], css: [], prompts: [], other: [],
        },
      });

      const result = await service.generateFeatureSeedContract('/repo', feature);
      expect(result.success).toBe(true);
      expect(result.data!.records.length).toBeGreaterThan(0);
      expect(result.data!.records[0].table).toBe('users');
      expect(result.data!.records[0].data).toHaveLength(2);
    });

    it('T2.4: includes staging in environments when staging fixture exists', async () => {
      mockReadFile.mockResolvedValue('[]' as any);

      const feature = makeFeature({
        name: 'payments',
        files: {
          api: [], schema: [], tests: { e2e: [], unit: [], integration: [] },
          fixtures: ['fixtures/staging.seed.json'], config: [], css: [], prompts: [], other: [],
        },
      });

      const result = await service.generateFeatureSeedContract('/repo', feature);
      expect(result.success).toBe(true);
      expect(result.data!.environment).toContain('staging');
    });

    it('T2.5: extracts SQL CREATE TABLE names', async () => {
      const sqlContent = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id)
);
`;
      mockReadFile.mockResolvedValue(sqlContent as any);

      const feature = makeFeature({
        name: 'orders',
        files: {
          api: [], schema: ['migrations/001_init.sql'], tests: { e2e: [], unit: [], integration: [] },
          fixtures: [], config: [], css: [], prompts: [], other: [],
        },
      });

      const result = await service.generateFeatureSeedContract('/repo', feature);
      expect(result.success).toBe(true);
      expect(result.data!.tables).toContain('users');
      expect(result.data!.tables).toContain('orders');
    });
  });

  // =========================================================================
  // T3: Merge & topological sort
  // =========================================================================
  describe('T3: Merge & topological sort', () => {
    it('T3.1: 3 features with no cross-deps preserves all operations', () => {
      const ops: SeedOperation[] = [
        { table: 'users', data: [{ id: '1' }], featureSource: 'auth', dependencies: [], checksum: 'a', environment: ['dev'] },
        { table: 'products', data: [{ id: '1' }], featureSource: 'shop', dependencies: [], checksum: 'b', environment: ['dev'] },
        { table: 'logs', data: [{ id: '1' }], featureSource: 'audit', dependencies: [], checksum: 'c', environment: ['dev'] },
      ];

      const sorted = service.topologicalSort(ops);
      expect(sorted).toHaveLength(3);
    });

    it('T3.2: orders table depends on users — users comes first', () => {
      const ops: SeedOperation[] = [
        { table: 'orders', data: [{ id: '1' }], featureSource: 'shop', dependencies: ['users'], checksum: 'b', environment: ['dev'] },
        { table: 'users', data: [{ id: '1' }], featureSource: 'auth', dependencies: [], checksum: 'a', environment: ['dev'] },
      ];

      const sorted = service.topologicalSort(ops);
      expect(sorted[0].table).toBe('users');
      expect(sorted[1].table).toBe('orders');
    });

    it('T3.3: complex dependency chain A->B->C', () => {
      const ops: SeedOperation[] = [
        { table: 'c', data: [], featureSource: 'f3', dependencies: ['b'], checksum: 'c', environment: ['dev'] },
        { table: 'a', data: [], featureSource: 'f1', dependencies: [], checksum: 'a', environment: ['dev'] },
        { table: 'b', data: [], featureSource: 'f2', dependencies: ['a'], checksum: 'b', environment: ['dev'] },
      ];

      const sorted = service.topologicalSort(ops);
      const order = sorted.map(o => o.table);
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
    });

    it('T3.4: circular dependency throws clear error', () => {
      const ops: SeedOperation[] = [
        { table: 'payments', data: [], featureSource: 'f1', dependencies: ['invoices'], checksum: 'a', environment: ['dev'] },
        { table: 'invoices', data: [], featureSource: 'f2', dependencies: ['payments'], checksum: 'b', environment: ['dev'] },
      ];

      expect(() => service.topologicalSort(ops)).toThrow(/Circular dependency detected/);
    });

    it('T3.5: 10 features with chain deps — all constraints respected', () => {
      const ops: SeedOperation[] = [];
      for (let i = 10; i >= 1; i--) {
        ops.push({
          table: `t${i}`, data: [], featureSource: `f${i}`,
          dependencies: i > 1 ? [`t${i - 1}`] : [],
          checksum: String(i), environment: ['dev'],
        });
      }

      const sorted = service.topologicalSort(ops);
      expect(sorted).toHaveLength(10);
      for (let i = 0; i < sorted.length; i++) {
        for (const dep of sorted[i].dependencies) {
          const depIdx = sorted.findIndex(s => s.table === dep);
          expect(depIdx).toBeLessThan(i);
        }
      }
    });

    it('T3.6: empty operations produces empty sorted list', () => {
      const sorted = service.topologicalSort([]);
      expect(sorted).toHaveLength(0);
    });

    it('T3.7: merge deduplicates tables keeping larger dataset', async () => {
      const contract1: SeedDataContract = {
        id: 'seed-a', type: 'seed', name: 'Feature A', filePath: '', status: 'active',
        version: '1.0.0', lastUpdated: '', tables: ['users'], order: 0, idempotent: true,
        environment: ['dev'],
        records: [{ table: 'users', data: [{ id: '1' }], dependencies: [] }],
      };
      const contract2: SeedDataContract = {
        id: 'seed-b', type: 'seed', name: 'Feature B', filePath: '', status: 'active',
        version: '1.0.0', lastUpdated: '', tables: ['users'], order: 0, idempotent: true,
        environment: ['dev'],
        records: [{ table: 'users', data: [{ id: '1' }, { id: '2' }, { id: '3' }], dependencies: [] }],
      };

      mockReaddir.mockResolvedValue(['a.seed.contracts.json', 'b.seed.contracts.json'] as any);
      mockReadFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath);
        if (p.endsWith('a.seed.contracts.json')) return JSON.stringify(contract1) as any;
        if (p.endsWith('b.seed.contracts.json')) return JSON.stringify(contract2) as any;
        if (p.includes('DATABASE_SCHEMA_CONTRACT')) throw new Error('not found');
        throw new Error('not found');
      });

      const result = await service.mergeSeedContracts('/repo');
      expect(result.success).toBe(true);
      const usersOps = result.data!.operations.filter(o => o.table === 'users');
      expect(usersOps).toHaveLength(1);
      expect(usersOps[0].data).toHaveLength(3);
    });
  });

  // =========================================================================
  // T4: Port discovery
  // =========================================================================
  describe('T4: Port discovery', () => {
    it('T4.1: returns exact preferred ports when available', async () => {
      const result = await service.discoverPorts([
        { name: 'api', preferredPort: 3000 },
        { name: 'db', preferredPort: 5432 },
        { name: 'redis', preferredPort: 6379 },
      ]);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(result.data![0]).toEqual({ serviceName: 'api', port: 3000, preferredPort: 3000 });
      expect(result.data![1]).toEqual({ serviceName: 'db', port: 5432, preferredPort: 5432 });
      expect(result.data![2]).toEqual({ serviceName: 'redis', port: 6379, preferredPort: 6379 });
    });

    it('T4.2: finds next port when preferred is occupied', async () => {
      const detectPortMod = jest.requireMock('detect-port') as any;
      detectPortMod.default.mockImplementation((port: number) => Promise.resolve(port === 3000 ? 3001 : port));

      const result = await service.discoverPorts([
        { name: 'api', preferredPort: 3000 },
      ]);

      expect(result.success).toBe(true);
      expect(result.data![0].port).toBe(3001);

      // Reset mock
      detectPortMod.default.mockImplementation((port: number) => Promise.resolve(port));
    });

    it('T4.3: uses default start port when no preference', async () => {
      const result = await service.discoverPorts([
        { name: 'generic' },
      ]);

      expect(result.success).toBe(true);
      expect(result.data![0].port).toBe(39200);
    });

    it('T4.5: two services requesting same port get unique ports', async () => {
      const result = await service.discoverPorts([
        { name: 'svc1', preferredPort: 3000 },
        { name: 'svc2', preferredPort: 3000 },
      ]);

      expect(result.success).toBe(true);
      const ports = result.data!.map(b => b.port);
      expect(new Set(ports).size).toBe(ports.length);
    });
  });

  // =========================================================================
  // T5: Seed execution & idempotency
  // =========================================================================
  describe('T5: Seed execution & idempotency', () => {
    const makePlan = (ops: Partial<SeedOperation>[]): SeedExecutionPlan => ({
      metadata: {
        generatedAt: new Date().toISOString(),
        totalOperations: ops.length,
        totalTables: ops.length,
        totalFeatures: 1,
        checksum: 'global',
      },
      operations: ops.map((o, i) => ({
        table: `table_${i}`,
        data: [{ id: String(i) }],
        featureSource: 'test',
        dependencies: [],
        checksum: `check_${i}`,
        environment: ['dev'] as any,
        ...o,
      })),
      rollback: [],
    });

    it('T5.1: first run executes all operations', async () => {
      const plan = makePlan([
        { table: 'users', checksum: 'aaa' },
        { table: 'posts', checksum: 'bbb' },
        { table: 'comments', checksum: 'ccc' },
      ]);

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (String(filePath).includes('SEED_EXECUTION_PLAN')) return JSON.stringify(plan) as any;
        if (String(filePath).includes('seed-checksums')) throw new Error('ENOENT');
        throw new Error('not found');
      });

      const result = await service.executeSeedPlan('/repo');
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('success');
      expect(result.data!.executed).toBe(3);
      expect(result.data!.skipped).toBe(0);
    });

    it('T5.2: second run with same checksums skips all', async () => {
      const plan = makePlan([
        { table: 'users', checksum: 'aaa' },
        { table: 'posts', checksum: 'bbb' },
      ]);

      const existingChecksums = { users: 'aaa', posts: 'bbb' };

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (String(filePath).includes('SEED_EXECUTION_PLAN')) return JSON.stringify(plan) as any;
        if (String(filePath).includes('seed-checksums')) return JSON.stringify(existingChecksums) as any;
        throw new Error('not found');
      });

      const result = await service.executeSeedPlan('/repo');
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('success');
      expect(result.data!.executed).toBe(0);
      expect(result.data!.skipped).toBe(2);
    });

    it('T5.3: re-executes only changed checksum operations', async () => {
      const plan = makePlan([
        { table: 'users', checksum: 'aaa' },
        { table: 'posts', checksum: 'bbb_new' },
        { table: 'comments', checksum: 'ccc' },
      ]);

      const existingChecksums = { users: 'aaa', posts: 'bbb_old', comments: 'ccc' };

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (String(filePath).includes('SEED_EXECUTION_PLAN')) return JSON.stringify(plan) as any;
        if (String(filePath).includes('seed-checksums')) return JSON.stringify(existingChecksums) as any;
        throw new Error('not found');
      });

      const result = await service.executeSeedPlan('/repo');
      expect(result.success).toBe(true);
      expect(result.data!.executed).toBe(1);
      expect(result.data!.skipped).toBe(2);
    });

    it('T5.5: rollback instructions are in reverse order', () => {
      const ops: SeedOperation[] = [
        { table: 'a', data: [], featureSource: 'f1', dependencies: [], checksum: '1', environment: ['dev'] },
        { table: 'b', data: [], featureSource: 'f2', dependencies: ['a'], checksum: '2', environment: ['dev'] },
        { table: 'c', data: [], featureSource: 'f3', dependencies: ['b'], checksum: '3', environment: ['dev'] },
      ];

      const sorted = service.topologicalSort(ops);
      const rollback = [...sorted].reverse().map(op => ({
        table: op.table,
        action: 'truncate' as const,
        featureSource: op.featureSource,
      }));

      expect(rollback[0].table).toBe('c');
      expect(rollback[1].table).toBe('b');
      expect(rollback[2].table).toBe('a');
    });
  });

  // =========================================================================
  // T6: IPC channel definitions
  // =========================================================================
  describe('T6: IPC channel definitions', () => {
    it('T6.1: all seed IPC channels are defined', async () => {
      const { IPC } = await import('../../../shared/ipc-channels');
      expect(IPC.SEED_GENERATE_FEATURE).toBe('seed:generate-feature');
      expect(IPC.SEED_GENERATE_ALL).toBe('seed:generate-all');
      expect(IPC.SEED_MERGE_PLAN).toBe('seed:merge-plan');
      expect(IPC.SEED_EXECUTE).toBe('seed:execute');
      expect(IPC.SEED_GET_STATUS).toBe('seed:get-status');
      expect(IPC.SEED_GET_PLAN).toBe('seed:get-plan');
      expect(IPC.SEED_PROGRESS).toBe('seed:progress');
    });

    it('T6.2: all startup IPC channels are defined', async () => {
      const { IPC } = await import('../../../shared/ipc-channels');
      expect(IPC.STARTUP_DISCOVER_PORTS).toBe('startup:discover-ports');
      expect(IPC.STARTUP_GET_PORTS).toBe('startup:get-ports');
      expect(IPC.STARTUP_GET_STATUS).toBe('startup:get-status');
      expect(IPC.STARTUP_STATUS_CHANGED).toBe('startup:status-changed');
    });

    it('T6.3: seed channels are in REQUEST_CHANNELS array', async () => {
      const { REQUEST_CHANNELS, IPC } = await import('../../../shared/ipc-channels');
      const channels = REQUEST_CHANNELS as readonly string[];
      expect(channels).toContain(IPC.SEED_GENERATE_FEATURE);
      expect(channels).toContain(IPC.SEED_MERGE_PLAN);
      expect(channels).toContain(IPC.SEED_EXECUTE);
      expect(channels).toContain(IPC.STARTUP_DISCOVER_PORTS);
    });

    it('T6.4: seed events are in EVENT_CHANNELS array', async () => {
      const { EVENT_CHANNELS, IPC } = await import('../../../shared/ipc-channels');
      const channels = EVENT_CHANNELS as readonly string[];
      expect(channels).toContain(IPC.SEED_PROGRESS);
      expect(channels).toContain(IPC.STARTUP_STATUS_CHANGED);
    });
  });

  // =========================================================================
  // T7: Edge cases
  // =========================================================================
  describe('T7: Edge cases', () => {
    it('T7.1: empty features list produces empty seed contracts', async () => {
      const result = await service.generateAllSeedContracts('/repo', []);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
    });

    it('T7.2: corrupt seed contract JSON is skipped during merge', async () => {
      mockReaddir.mockResolvedValue(['good.seed.contracts.json', 'bad.seed.contracts.json'] as any);
      mockReadFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath);
        if (p.endsWith('good.seed.contracts.json')) {
          return JSON.stringify({
            id: 'seed-good', type: 'seed', name: 'Good',
            filePath: '', status: 'active', version: '1.0.0',
            lastUpdated: '', tables: ['users'], order: 0,
            idempotent: true, environment: ['dev'],
            records: [{ table: 'users', data: [{ id: '1' }], dependencies: [] }],
          }) as any;
        }
        if (p.endsWith('bad.seed.contracts.json')) return '{corrupt json{{' as any;
        if (p.includes('DATABASE_SCHEMA_CONTRACT')) throw new Error('not found');
        throw new Error('not found');
      });

      const result = await service.mergeSeedContracts('/repo');
      expect(result.success).toBe(true);
      expect(result.data!.operations).toHaveLength(1);
      expect(result.data!.operations[0].table).toBe('users');
    });

    it('T7.3: execute without plan returns clear error', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await service.executeSeedPlan('/repo');
      expect(result.success).toBe(false);
      expect(result.error!.message).toContain('SEED_MERGE_PLAN first');
    });

    it('T7.4: concurrent execution calls return in-progress error', async () => {
      const plan: SeedExecutionPlan = {
        metadata: { generatedAt: '', totalOperations: 1, totalTables: 1, totalFeatures: 1, checksum: '' },
        operations: [{ table: 'slow', data: [], featureSource: 'f', dependencies: [], checksum: 'x', environment: ['dev'] }],
        rollback: [],
      };

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (String(filePath).includes('SEED_EXECUTION_PLAN')) return JSON.stringify(plan) as any;
        if (String(filePath).includes('seed-checksums')) throw new Error('ENOENT');
        throw new Error('not found');
      });

      // Start first execution
      const first = service.executeSeedPlan('/repo');
      // Immediately try second
      const second = await service.executeSeedPlan('/repo');
      await first;

      expect(second.success).toBe(false);
      expect(second.error!.message).toContain('already in progress');
    });

    it('T7.5: checksum computation is deterministic', () => {
      const data = { table: 'users', data: [{ id: '1' }] };
      const checksum1 = service.computeChecksum(data);
      const checksum2 = service.computeChecksum(data);
      expect(checksum1).toBe(checksum2);
      expect(checksum1).toHaveLength(16);
    });

    it('T7.6: getSeedStatus returns executing state', () => {
      const status = service.getSeedStatus();
      expect(status.success).toBe(true);
      expect(status.data!.executing).toBe(false);
    });

    it('T7.7: getPorts returns empty when no ports discovered', () => {
      const result = service.getPorts();
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
    });

    it('T7.8: getStartupStatus returns pending initially', () => {
      const result = service.getStartupStatus();
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('pending');
    });
  });

  // =========================================================================
  // T8: Schema cross-reference validation
  // =========================================================================
  describe('T8: Schema cross-reference validation', () => {
    it('T8.1: reports error for seed tables not in schema', async () => {
      mockReaddir.mockResolvedValue(['feature.contracts.json'] as any);
      mockReadFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath);
        if (p.endsWith('feature.contracts.json')) {
          return JSON.stringify({
            schemas: [{ name: 'users', type: 'database' }],
          }) as any;
        }
        if (p.includes('DATABASE_SCHEMA_CONTRACT')) throw new Error('not found');
        throw new Error('not found');
      });

      const contracts: SeedDataContract[] = [{
        id: 'seed-1', type: 'seed', name: 'Test', filePath: '', status: 'active',
        version: '1.0.0', lastUpdated: '', tables: ['users', 'nonexistent'], order: 0,
        idempotent: true, environment: ['dev'], records: [],
      }];

      const result = await service.validateAgainstSchema('/repo', contracts);
      expect(result.errors.some(e => e.includes('nonexistent'))).toBe(true);
      expect(result.errors.some(e => e.includes('users'))).toBe(false);
    });

    it('T8.2: reports warning for schema tables with no seed data', async () => {
      mockReaddir.mockResolvedValue(['feature.contracts.json'] as any);
      mockReadFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath);
        if (p.endsWith('feature.contracts.json')) {
          return JSON.stringify({
            schemas: [
              { name: 'users', type: 'database' },
              { name: 'audit_logs', type: 'database' },
            ],
          }) as any;
        }
        if (p.includes('DATABASE_SCHEMA_CONTRACT')) throw new Error('not found');
        throw new Error('not found');
      });

      const contracts: SeedDataContract[] = [{
        id: 'seed-1', type: 'seed', name: 'Test', filePath: '', status: 'active',
        version: '1.0.0', lastUpdated: '', tables: ['users'], order: 0,
        idempotent: true, environment: ['dev'], records: [],
      }];

      const result = await service.validateAgainstSchema('/repo', contracts);
      expect(result.warnings.some(w => w.includes('audit_logs'))).toBe(true);
    });

    it('T8.3: valid when all seed tables exist in schema', async () => {
      mockReaddir.mockResolvedValue(['feature.contracts.json'] as any);
      mockReadFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath);
        if (p.endsWith('feature.contracts.json')) {
          return JSON.stringify({
            schemas: [
              { name: 'users', type: 'database' },
              { name: 'posts', type: 'database' },
            ],
          }) as any;
        }
        if (p.includes('DATABASE_SCHEMA_CONTRACT')) throw new Error('not found');
        throw new Error('not found');
      });

      const contracts: SeedDataContract[] = [{
        id: 'seed-1', type: 'seed', name: 'Test', filePath: '', status: 'active',
        version: '1.0.0', lastUpdated: '', tables: ['users', 'posts'], order: 0,
        idempotent: true, environment: ['dev'], records: [],
      }];

      const result = await service.validateAgainstSchema('/repo', contracts);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('T8.4: skips validation gracefully when no contracts directory exists', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const contracts: SeedDataContract[] = [{
        id: 'seed-1', type: 'seed', name: 'Test', filePath: '', status: 'active',
        version: '1.0.0', lastUpdated: '', tables: ['users'], order: 0,
        idempotent: true, environment: ['dev'], records: [],
      }];

      const result = await service.validateAgainstSchema('/repo', contracts);
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('No schema contracts found'))).toBe(true);
    });
  });

  // =========================================================================
  // T9: Contract type registration
  // =========================================================================
  describe('T9: Contract type registration', () => {
    it('T9.1: seed is a valid ContractType', () => {
      const type: import('../../../shared/types').ContractType = 'seed';
      expect(type).toBe('seed');
    });

    it('T9.2: CONTRACTS_PATHS includes seed', async () => {
      const { CONTRACTS_PATHS } = await import('../../../shared/agent-protocol');
      expect(CONTRACTS_PATHS.seed).toBe('House_Rules_Contracts/SEED_DATA_CONTRACT.md');
    });
  });
});
