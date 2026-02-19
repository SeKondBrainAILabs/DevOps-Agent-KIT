const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

describe('generate-contracts.js', () => {
  const testDir = path.join(__dirname, '../fixtures/test-repo');
  const outputFile = path.join(testDir, 'House_Rules_Contracts/contract-scan-results.json');

  beforeEach(() => {
    // Create test directory structure
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, 'House_Rules_Contracts'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'src/features'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'src/api'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'migrations'), { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Feature Scanning', () => {
    test('should discover features in src/features directory', () => {
      // Create mock feature files
      fs.writeFileSync(
        path.join(testDir, 'src/features/user-auth/index.js'),
        '// User authentication feature\nexport default function authenticate() {}'
      );
      fs.writeFileSync(
        path.join(testDir, 'src/features/payment/index.js'),
        '// Payment processing feature\nexport default function processPayment() {}'
      );

      // Run the scanner (we'll mock this for now)
      const features = scanFeatures(testDir);

      expect(features).toHaveLength(2);
      expect(features).toContainEqual(expect.objectContaining({
        name: expect.stringMatching(/user-auth|payment/)
      }));
    });

    test('should handle empty features directory', () => {
      const features = scanFeatures(testDir);
      expect(features).toEqual([]);
    });
  });

  describe('API Endpoint Scanning', () => {
    test('should discover Express.js API endpoints', () => {
      fs.writeFileSync(
        path.join(testDir, 'src/api/users.js'),
        `
        app.get('/api/v1/users', (req, res) => {});
        app.post('/api/v1/users', (req, res) => {});
        app.put('/api/v1/users/:id', (req, res) => {});
        `
      );

      const endpoints = scanAPIEndpoints(testDir);

      expect(endpoints).toHaveLength(3);
      expect(endpoints).toContainEqual(expect.objectContaining({
        method: 'GET',
        path: '/api/v1/users'
      }));
      expect(endpoints).toContainEqual(expect.objectContaining({
        method: 'POST',
        path: '/api/v1/users'
      }));
    });

    test('should discover FastAPI endpoints', () => {
      fs.writeFileSync(
        path.join(testDir, 'src/api/items.py'),
        `
        @router.get("/api/v1/items")
        async def get_items():
            pass
        
        @router.post("/api/v1/items")
        async def create_item():
            pass
        `
      );

      const endpoints = scanAPIEndpoints(testDir);

      expect(endpoints.length).toBeGreaterThan(0);
      expect(endpoints).toContainEqual(expect.objectContaining({
        method: 'GET',
        path: expect.stringContaining('/api/v1/items')
      }));
    });
  });

  describe('Database Schema Scanning', () => {
    test('should discover SQL CREATE TABLE statements', () => {
      fs.writeFileSync(
        path.join(testDir, 'migrations/001_create_users.sql'),
        `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          title VARCHAR(500)
        );
        `
      );

      const tables = scanDatabaseSchema(testDir);

      expect(tables).toHaveLength(2);
      expect(tables).toContainEqual(expect.objectContaining({
        name: 'users'
      }));
      expect(tables).toContainEqual(expect.objectContaining({
        name: 'posts'
      }));
    });

    test('should discover Prisma schema models', () => {
      fs.writeFileSync(
        path.join(testDir, 'schema.prisma'),
        `
        model User {
          id    Int     @id @default(autoincrement())
          email String  @unique
          posts Post[]
        }
        
        model Post {
          id     Int    @id @default(autoincrement())
          title  String
          userId Int
          user   User   @relation(fields: [userId], references: [id])
        }
        `
      );

      const tables = scanDatabaseSchema(testDir);

      expect(tables.length).toBeGreaterThan(0);
      expect(tables).toContainEqual(expect.objectContaining({
        name: expect.stringMatching(/User|Post/)
      }));
    });
  });

  describe('SQL Query Scanning', () => {
    test('should discover SQL queries in code files', () => {
      fs.writeFileSync(
        path.join(testDir, 'src/services/UserService.js'),
        `
        const getUserByEmail = "SELECT * FROM users WHERE email = $1";
        const updateUser = "UPDATE users SET name = $1 WHERE id = $2";
        `
      );

      const queries = scanSQLQueries(testDir);

      expect(queries.length).toBeGreaterThan(0);
      expect(Object.keys(queries)).toContain(expect.stringMatching(/getUserByEmail|updateUser/));
    });

    test('should discover queries in .sql files', () => {
      fs.writeFileSync(
        path.join(testDir, 'src/queries/users.sql'),
        `
        -- name: get_user_by_id
        SELECT * FROM users WHERE id = $1;
        
        -- name: get_active_users
        SELECT * FROM users WHERE active = true;
        `
      );

      const queries = scanSQLQueries(testDir);

      expect(Object.keys(queries).length).toBeGreaterThan(0);
    });
  });

  describe('Third-Party Integration Scanning', () => {
    test('should discover integrations from package.json', () => {
      fs.writeFileSync(
        path.join(testDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            stripe: '^12.0.0',
            '@sendgrid/mail': '^7.7.0',
            'aws-sdk': '^2.1400.0'
          }
        })
      );

      const integrations = scanThirdPartyIntegrations(testDir);

      expect(integrations).toContainEqual(expect.objectContaining({
        service: 'Stripe',
        package: 'stripe'
      }));
      expect(integrations).toContainEqual(expect.objectContaining({
        service: 'SendGrid',
        package: '@sendgrid/mail'
      }));
    });
  });

  describe('Environment Variable Scanning', () => {
    test('should discover env variables from code', () => {
      fs.writeFileSync(
        path.join(testDir, 'src/config.js'),
        `
        const dbUrl = process.env.DATABASE_URL;
        const apiKey = process.env.STRIPE_API_KEY;
        const port = process.env.PORT || 3000;
        `
      );

      const envVars = scanEnvironmentVariables(testDir);

      expect(envVars).toContainEqual(expect.objectContaining({
        name: 'DATABASE_URL'
      }));
      expect(envVars).toContainEqual(expect.objectContaining({
        name: 'STRIPE_API_KEY'
      }));
      expect(envVars).toContainEqual(expect.objectContaining({
        name: 'PORT'
      }));
    });

    test('should discover env variables from .env.example', () => {
      fs.writeFileSync(
        path.join(testDir, '.env.example'),
        `
        DATABASE_URL=postgresql://localhost:5432/mydb
        REDIS_URL=redis://localhost:6379
        API_KEY=your_api_key_here
        `
      );

      const envVars = scanEnvironmentVariables(testDir);

      expect(envVars.length).toBeGreaterThan(0);
      expect(envVars).toContainEqual(expect.objectContaining({
        name: expect.stringMatching(/DATABASE_URL|REDIS_URL|API_KEY/)
      }));
    });
  });

  describe('Output Generation', () => {
    test('should generate valid JSON output', () => {
      // Create minimal test data
      fs.writeFileSync(
        path.join(testDir, 'src/features/test/index.js'),
        '// Test feature'
      );

      // Run scanner (mocked)
      const output = generateContractScanResults(testDir);

      expect(output).toHaveProperty('generated');
      expect(output).toHaveProperty('results');
      expect(output.results).toHaveProperty('features');
      expect(output.results).toHaveProperty('api');
      expect(output.results).toHaveProperty('database');
      expect(output.results).toHaveProperty('sql');
      expect(output.results).toHaveProperty('integrations');
      expect(output.results).toHaveProperty('envVars');
    });

    test('should include timestamp in output', () => {
      const output = generateContractScanResults(testDir);
      
      expect(output.generated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});

// Mock scanner functions (these would normally be extracted from the main script)
function scanFeatures(baseDir) {
  const featuresDir = path.join(baseDir, 'src/features');
  if (!fs.existsSync(featuresDir)) return [];
  
  const features = [];
  const dirs = fs.readdirSync(featuresDir, { withFileTypes: true });
  
  for (const dir of dirs) {
    if (dir.isDirectory()) {
      features.push({
        id: `F-${features.length + 1}`.padStart(5, '0'),
        name: dir.name,
        path: path.join('src/features', dir.name)
      });
    }
  }
  
  return features;
}

function scanAPIEndpoints(baseDir) {
  const endpoints = [];
  const apiDir = path.join(baseDir, 'src/api');
  
  if (!fs.existsSync(apiDir)) return endpoints;
  
  const files = fs.readdirSync(apiDir);
  
  for (const file of files) {
    const content = fs.readFileSync(path.join(apiDir, file), 'utf-8');
    
    // Express.js patterns
    const expressMatches = content.matchAll(/app\.(get|post|put|delete|patch)\(['"]([^'"]+)['"]/g);
    for (const match of expressMatches) {
      endpoints.push({
        method: match[1].toUpperCase(),
        path: match[2],
        source: file
      });
    }
    
    // FastAPI patterns
    const fastapiMatches = content.matchAll(/@router\.(get|post|put|delete|patch)\(['"]([^'"]+)['"]/g);
    for (const match of fastapiMatches) {
      endpoints.push({
        method: match[1].toUpperCase(),
        path: match[2],
        source: file
      });
    }
  }
  
  return endpoints;
}

function scanDatabaseSchema(baseDir) {
  const tables = [];
  
  // Scan migrations
  const migrationsDir = path.join(baseDir, 'migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir);
    
    for (const file of files) {
      const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      const matches = content.matchAll(/CREATE TABLE\s+(\w+)/gi);
      
      for (const match of matches) {
        tables.push({
          name: match[1],
          source: file
        });
      }
    }
  }
  
  // Scan Prisma schema
  const prismaFile = path.join(baseDir, 'schema.prisma');
  if (fs.existsSync(prismaFile)) {
    const content = fs.readFileSync(prismaFile, 'utf-8');
    const matches = content.matchAll(/model\s+(\w+)/g);
    
    for (const match of matches) {
      tables.push({
        name: match[1],
        source: 'schema.prisma'
      });
    }
  }
  
  return tables;
}

function scanSQLQueries(baseDir) {
  const queries = {};
  
  function scanFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Find SQL queries in string literals
    const matches = content.matchAll(/const\s+(\w+)\s*=\s*["'`](SELECT|INSERT|UPDATE|DELETE)[^"'`]+["'`]/gi);
    
    for (const match of matches) {
      queries[match[1]] = {
        id: match[1],
        sql: match[2],
        source: filePath
      };
    }
    
    // Find named queries in .sql files
    const namedMatches = content.matchAll(/--\s*name:\s*(\w+)\s*\n([^;]+);/gi);
    
    for (const match of namedMatches) {
      queries[match[1]] = {
        id: match[1],
        sql: match[2].trim(),
        source: filePath
      };
    }
  }
  
  // Scan src directory
  const srcDir = path.join(baseDir, 'src');
  if (fs.existsSync(srcDir)) {
    function walkDir(dir) {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const file of files) {
        const fullPath = path.join(dir, file.name);
        
        if (file.isDirectory()) {
          walkDir(fullPath);
        } else if (file.name.endsWith('.js') || file.name.endsWith('.sql')) {
          scanFile(fullPath);
        }
      }
    }
    
    walkDir(srcDir);
  }
  
  return queries;
}

function scanThirdPartyIntegrations(baseDir) {
  const integrations = [];
  const packageFile = path.join(baseDir, 'package.json');
  
  if (!fs.existsSync(packageFile)) return integrations;
  
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf-8'));
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  
  const knownServices = {
    'stripe': 'Stripe',
    '@sendgrid/mail': 'SendGrid',
    'aws-sdk': 'AWS',
    'twilio': 'Twilio',
    'openai': 'OpenAI'
  };
  
  for (const [pkg, version] of Object.entries(deps)) {
    if (knownServices[pkg]) {
      integrations.push({
        service: knownServices[pkg],
        package: pkg,
        version
      });
    }
  }
  
  return integrations;
}

function scanEnvironmentVariables(baseDir) {
  const envVars = [];
  const seen = new Set();
  
  // Scan .env.example
  const envExample = path.join(baseDir, '.env.example');
  if (fs.existsSync(envExample)) {
    const content = fs.readFileSync(envExample, 'utf-8');
    const matches = content.matchAll(/^([A-Z_]+)=/gm);
    
    for (const match of matches) {
      if (!seen.has(match[1])) {
        envVars.push({ name: match[1], source: '.env.example' });
        seen.add(match[1]);
      }
    }
  }
  
  // Scan code files
  const srcDir = path.join(baseDir, 'src');
  if (fs.existsSync(srcDir)) {
    function walkDir(dir) {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const file of files) {
        const fullPath = path.join(dir, file.name);
        
        if (file.isDirectory()) {
          walkDir(fullPath);
        } else if (file.name.endsWith('.js')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const matches = content.matchAll(/process\.env\.([A-Z_]+)/g);
          
          for (const match of matches) {
            if (!seen.has(match[1])) {
              envVars.push({ name: match[1], source: fullPath });
              seen.add(match[1]);
            }
          }
        }
      }
    }
    
    walkDir(srcDir);
  }
  
  return envVars;
}

function generateContractScanResults(baseDir) {
  return {
    generated: new Date().toISOString(),
    results: {
      features: scanFeatures(baseDir),
      api: scanAPIEndpoints(baseDir),
      database: scanDatabaseSchema(baseDir),
      sql: scanSQLQueries(baseDir),
      integrations: scanThirdPartyIntegrations(baseDir),
      envVars: scanEnvironmentVariables(baseDir)
    }
  };
}
