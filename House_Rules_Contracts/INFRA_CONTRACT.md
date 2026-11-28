# Infrastructure Contract

**Last Updated:** 2024-12-02  
**Version:** 1.0.1  
**Status:** Initial Template

---

## Purpose

This contract documents **all infrastructure configuration, environment variables, and deployment settings**. Coding agents **MUST check this file before adding configuration** to:
- **Prevent duplicate environment variables**
- **Maintain single source of truth** for all config
- **Avoid configuration conflicts** between modules
- **Ensure consistent naming conventions**
- **Prevent multiple versions** of the same config
- **Centralize secrets management**

---

## Change Log

| Date | Version | Agent/Author | Changes | Impact |
|------|---------|--------------|---------|--------|
| 2024-12-02 | 1.0.0 | DevOps Agent | Initial template creation | N/A - Template only |
| 2026-11-28 | 1.0.1 | DevOps Agent | Added KANVAS_PORT and KANVAS_PORT_RANGE environment variables | Infrastructure |

---

## Environment Variables

### Variable Naming Convention

**Format:** `[CATEGORY]_[SUBCATEGORY]_[NAME]`

**Examples:**
- `DATABASE_PRIMARY_URL`
- `REDIS_CACHE_URL`
- `AWS_S3_BUCKET_NAME`
- `SENDGRID_API_KEY`
- `JWT_SECRET_KEY`
- `FEATURE_AUTH_ENABLED`

**Categories:**
- `DATABASE_*` - Database connections
- `REDIS_*` - Redis/caching
- `AWS_*` - AWS services
- `[SERVICE]_*` - Third-party services (SENDGRID_, STRIPE_, etc.)
- `JWT_*` - Authentication/JWT
- `API_*` - API configuration
- `FEATURE_*` - Feature flags
- `LOG_*` - Logging configuration
- `SMTP_*` - Email configuration
- `APP_*` - Application settings

---

### Core Application Variables

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `NODE_ENV` | string | YES | `development` | Environment name | `production`, `staging`, `development` | All modules |
| `APP_NAME` | string | YES | - | Application name | `MyApp` | Logging, emails |
| `APP_VERSION` | string | NO | `1.0.0` | Application version | `1.2.3` | Monitoring, headers |
| `APP_URL` | string | YES | - | Application base URL | `https://app.example.com` | Email links, redirects |
| `APP_PORT` | integer | YES | `3000` | Server port | `3000`, `8080` | Server startup |
| `APP_HOST` | string | NO | `0.0.0.0` | Server host | `0.0.0.0`, `localhost` | Server binding |
| `KANVAS_PORT` | integer | NO | `5173` | Kanvas preferred port | `5173`, `6000` | electron.vite.config.ts |
| `KANVAS_PORT_RANGE` | string | NO | `5173-5183` | Kanvas port range | `5173-5183`, `5200-5210` | electron.vite.config.ts |

**Added:** 2024-01-15  
**Last Modified:** 2024-01-15

---

### Database Configuration

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `DATABASE_URL` | string | YES | - | Primary database connection string | `postgresql://user:pass@host:5432/db` | All DB modules |
| `DATABASE_HOST` | string | NO | `localhost` | Database host | `db.example.com` | DB connection |
| `DATABASE_PORT` | integer | NO | `5432` | Database port | `5432` (PostgreSQL) | DB connection |
| `DATABASE_NAME` | string | NO | - | Database name | `myapp_production` | DB connection |
| `DATABASE_USER` | string | NO | - | Database username | `dbuser` | DB connection |
| `DATABASE_PASSWORD` | string | NO | - | Database password | `securepass123` | DB connection |
| `DATABASE_POOL_MIN` | integer | NO | `2` | Min connection pool size | `2` | Connection pooling |
| `DATABASE_POOL_MAX` | integer | NO | `20` | Max connection pool size | `20` | Connection pooling |
| `DATABASE_SSL` | boolean | NO | `true` | Enable SSL connection | `true`, `false` | DB connection |

**Added:** 2024-01-15  
**Last Modified:** 2024-01-15  
**See Also:** DATABASE_SCHEMA_CONTRACT.md

---

### Redis / Caching Configuration

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `REDIS_URL` | string | YES | - | Redis connection string | `redis://user:pass@host:6379` | Caching, sessions |
| `REDIS_HOST` | string | NO | `localhost` | Redis host | `redis.example.com` | Redis connection |
| `REDIS_PORT` | integer | NO | `6379` | Redis port | `6379` | Redis connection |
| `REDIS_PASSWORD` | string | NO | - | Redis password | `redispass123` | Redis connection |
| `REDIS_DB` | integer | NO | `0` | Redis database number | `0`, `1`, `2` | Redis connection |
| `CACHE_TTL` | integer | NO | `300` | Default cache TTL (seconds) | `300` (5 minutes) | Caching layer |
| `CACHE_ENABLED` | boolean | NO | `true` | Enable caching | `true`, `false` | Caching layer |

**Added:** 2024-01-15  
**Last Modified:** 2024-01-15

---

### Authentication / JWT Configuration

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `JWT_SECRET` | string | YES | - | JWT signing secret | `your-256-bit-secret` | Auth module |
| `JWT_EXPIRATION` | string | NO | `24h` | JWT token expiration | `24h`, `7d`, `3600` (seconds) | Auth module |
| `JWT_REFRESH_EXPIRATION` | string | NO | `7d` | Refresh token expiration | `7d`, `30d` | Auth module |
| `JWT_ALGORITHM` | string | NO | `HS256` | JWT signing algorithm | `HS256`, `RS256` | Auth module |
| `PASSWORD_RESET_EXPIRATION` | integer | NO | `3600` | Password reset token TTL (seconds) | `3600` (1 hour) | Auth module |
| `MAX_LOGIN_ATTEMPTS` | integer | NO | `5` | Max failed login attempts | `5` | Auth module |
| `LOCKOUT_DURATION` | integer | NO | `900` | Account lockout duration (seconds) | `900` (15 minutes) | Auth module |

**Added:** 2024-01-15  
**Last Modified:** 2024-01-15  
**See Also:** FEATURES_CONTRACT.md (F-001 - User Authentication)

---

### Third-Party Service Configuration

#### SendGrid (Email)

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `SENDGRID_API_KEY` | string | YES | - | SendGrid API key | `SG.xxx...` | Email service |
| `SENDGRID_FROM_EMAIL` | string | YES | - | Default sender email | `noreply@example.com` | Email service |
| `SENDGRID_FROM_NAME` | string | NO | `APP_NAME` | Default sender name | `MyApp` | Email service |

**Added:** 2024-01-15  
**See Also:** THIRD_PARTY_INTEGRATIONS.md (SendGrid)

#### Stripe (Payments)

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `STRIPE_SECRET_KEY` | string | YES | - | Stripe secret API key | `sk_live_...` | Payment service |
| `STRIPE_PUBLISHABLE_KEY` | string | YES | - | Stripe publishable key | `pk_live_...` | Frontend |
| `STRIPE_WEBHOOK_SECRET` | string | YES | - | Stripe webhook secret | `whsec_...` | Webhook handler |

**Added:** 2024-01-20  
**See Also:** THIRD_PARTY_INTEGRATIONS.md (Stripe)

#### AWS S3 (Storage)

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `AWS_ACCESS_KEY_ID` | string | YES | - | AWS access key | `AKIAIOSFODNN7EXAMPLE` | S3 service |
| `AWS_SECRET_ACCESS_KEY` | string | YES | - | AWS secret key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` | S3 service |
| `AWS_REGION` | string | YES | - | AWS region | `us-east-1` | S3 service |
| `AWS_S3_BUCKET` | string | YES | - | S3 bucket name | `myapp-production` | S3 service |

**Added:** 2024-01-10  
**See Also:** THIRD_PARTY_INTEGRATIONS.md (AWS S3)

---

### API Configuration

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `API_VERSION` | string | NO | `v1` | API version prefix | `v1`, `v2` | API routes |
| `API_RATE_LIMIT_WINDOW` | integer | NO | `3600` | Rate limit window (seconds) | `3600` (1 hour) | Rate limiter |
| `API_RATE_LIMIT_MAX` | integer | NO | `1000` | Max requests per window | `1000` | Rate limiter |
| `API_TIMEOUT` | integer | NO | `30000` | API request timeout (ms) | `30000` (30 seconds) | API middleware |
| `API_CORS_ORIGIN` | string | NO | `*` | CORS allowed origins | `https://example.com` | CORS middleware |

**Added:** 2024-01-15  
**Last Modified:** 2024-01-15

---

### Logging Configuration

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `LOG_LEVEL` | string | NO | `info` | Logging level | `debug`, `info`, `warn`, `error` | Logger |
| `LOG_FORMAT` | string | NO | `json` | Log output format | `json`, `text` | Logger |
| `LOG_FILE_PATH` | string | NO | `logs/app.log` | Log file location | `logs/app.log` | File logger |
| `LOG_MAX_SIZE` | string | NO | `10m` | Max log file size | `10m`, `100m` | Log rotation |
| `LOG_MAX_FILES` | integer | NO | `7` | Max log files to keep | `7` | Log rotation |
| `LOG_CONSOLE_ENABLED` | boolean | NO | `true` | Enable console logging | `true`, `false` | Logger |

**Added:** 2024-01-15  
**Last Modified:** 2024-01-15

---

### Feature Flags

| Variable | Type | Required | Default | Description | Example | Used By |
|----------|------|----------|---------|-------------|---------|---------|
| `FEATURE_AUTH_EMAIL_VERIFICATION` | boolean | NO | `true` | Require email verification | `true`, `false` | Auth module |
| `FEATURE_AUTH_2FA` | boolean | NO | `false` | Enable 2FA | `true`, `false` | Auth module |
| `FEATURE_SOCIAL_LOGIN` | boolean | NO | `false` | Enable social login | `true`, `false` | Auth module |
| `FEATURE_[NAME]_ENABLED` | boolean | NO | `false` | Enable specific feature | `true`, `false` | Feature module |

**Added:** 2024-01-15  
**Last Modified:** 2024-02-10  
**See Also:** FEATURES_CONTRACT.md

---

## Configuration Files

### Application Configuration

**File:** `config/app.js`  
**Purpose:** Main application configuration  
**Environment Variables Used:**
- `NODE_ENV`
- `APP_NAME`
- `APP_VERSION`
- `APP_URL`
- `APP_PORT`
- `APP_HOST`

**Structure:**
```javascript
module.exports = {
  env: process.env.NODE_ENV || 'development',
  name: process.env.APP_NAME,
  version: process.env.APP_VERSION || '1.0.0',
  url: process.env.APP_URL,
  port: parseInt(process.env.APP_PORT, 10) || 3000,
  host: process.env.APP_HOST || '0.0.0.0'
};
```

---

### Database Configuration

**File:** `config/database.js`  
**Purpose:** Database connection configuration  
**Environment Variables Used:**
- `DATABASE_URL`
- `DATABASE_HOST`
- `DATABASE_PORT`
- `DATABASE_NAME`
- `DATABASE_USER`
- `DATABASE_PASSWORD`
- `DATABASE_POOL_MIN`
- `DATABASE_POOL_MAX`
- `DATABASE_SSL`

**Structure:**
```javascript
module.exports = {
  url: process.env.DATABASE_URL,
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT, 10) || 5432,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  pool: {
    min: parseInt(process.env.DATABASE_POOL_MIN, 10) || 2,
    max: parseInt(process.env.DATABASE_POOL_MAX, 10) || 20
  },
  ssl: process.env.DATABASE_SSL === 'true'
};
```

**See Also:** DATABASE_SCHEMA_CONTRACT.md

---

### Redis Configuration

**File:** `config/redis.js`  
**Purpose:** Redis connection configuration  
**Environment Variables Used:**
- `REDIS_URL`
- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_PASSWORD`
- `REDIS_DB`
- `CACHE_TTL`
- `CACHE_ENABLED`

---

## Environment Files

### `.env.example`

**Purpose:** Template for environment variables (committed to repo)  
**Location:** Project root  
**Usage:** Copy to `.env` and fill in actual values

```bash
# Application
NODE_ENV=development
APP_NAME=MyApp
APP_VERSION=1.0.0
APP_URL=http://localhost:3000
APP_PORT=3000

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/myapp_dev
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=20

# Redis
REDIS_URL=redis://localhost:6379
CACHE_TTL=300
CACHE_ENABLED=true

# Authentication
JWT_SECRET=your-256-bit-secret-change-this
JWT_EXPIRATION=24h
MAX_LOGIN_ATTEMPTS=5

# SendGrid
SENDGRID_API_KEY=your-sendgrid-api-key
SENDGRID_FROM_EMAIL=noreply@example.com

# AWS S3
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_REGION=us-east-1
AWS_S3_BUCKET=myapp-dev

# Feature Flags
FEATURE_AUTH_EMAIL_VERIFICATION=true
FEATURE_AUTH_2FA=false
```

---

### `.env` (Local Development)

**Purpose:** Local development environment variables (gitignored)  
**Location:** Project root  
**Usage:** Copy from `.env.example` and customize

⚠️ **NEVER commit this file to git!**

---

### `.env.production`

**Purpose:** Production environment variables template  
**Location:** Project root or deployment config  
**Usage:** Used by deployment pipeline

⚠️ **Contains sensitive data - store in secrets manager!**

---

### `.env.staging`

**Purpose:** Staging environment variables template  
**Location:** Project root or deployment config  
**Usage:** Used by staging deployment

---

## Secrets Management

### Development

**Method:** `.env` file (gitignored)  
**Storage:** Local filesystem  
**Access:** Developers only

### Staging

**Method:** Environment variables in deployment platform  
**Storage:** Heroku Config Vars / Vercel Environment Variables  
**Access:** DevOps team

### Production

**Method:** Secrets manager  
**Storage:** AWS Secrets Manager / HashiCorp Vault  
**Access:** Automated deployment pipeline only  
**Rotation:** Quarterly for API keys, monthly for passwords

---

## Deployment Configuration

### Environments

| Environment | URL | Branch | Auto-Deploy | Database | Purpose |
|-------------|-----|--------|-------------|----------|---------|
| Development | `http://localhost:3000` | - | No | Local | Local dev |
| Staging | `https://staging.example.com` | `develop` | Yes | Staging DB | Testing |
| Production | `https://app.example.com` | `main` | No | Production DB | Live users |

---

### CI/CD Configuration

**File:** `.github/workflows/deploy.yml`  
**Purpose:** GitHub Actions deployment workflow

**Environment Variables Set in GitHub Secrets:**
- `DATABASE_URL`
- `JWT_SECRET`
- `SENDGRID_API_KEY`
- `STRIPE_SECRET_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- All other sensitive variables

---

### Docker Configuration

**File:** `Dockerfile`  
**Purpose:** Container image definition

**Environment Variables:**
- Passed via `docker run -e` or `docker-compose.yml`
- Never hardcoded in Dockerfile

**File:** `docker-compose.yml`  
**Purpose:** Local development with Docker

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "${APP_PORT}:3000"
    environment:
      - NODE_ENV=${NODE_ENV}
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      - JWT_SECRET=${JWT_SECRET}
    env_file:
      - .env
```

---

## Infrastructure Resources

### Hosting

| Resource | Provider | Plan | Cost | Purpose |
|----------|----------|------|------|---------|
| Web Server | Heroku / Vercel | Pro | $X/month | Host application |
| Database | AWS RDS / Heroku Postgres | Standard | $X/month | PostgreSQL database |
| Cache | Redis Cloud / Heroku Redis | Standard | $X/month | Redis cache |
| Storage | AWS S3 | Pay-as-you-go | $X/month | File storage |

---

### Monitoring & Logging

| Resource | Provider | Plan | Cost | Purpose |
|----------|----------|------|------|---------|
| Error Tracking | Sentry | Team | $X/month | Error monitoring |
| Logging | LogDNA / Papertrail | Standard | $X/month | Centralized logs |
| Uptime Monitoring | Pingdom / UptimeRobot | Pro | $X/month | Uptime checks |
| Performance | New Relic / DataDog | Standard | $X/month | APM monitoring |

---

## Notes for Coding Agents

### 🚨 CRITICAL RULES:

1. **ALWAYS check this contract before adding environment variables**
2. **NEVER create duplicate environment variables** with different names
3. **FOLLOW naming convention** - `[CATEGORY]_[SUBCATEGORY]_[NAME]`
4. **NEVER hardcode secrets** - always use environment variables
5. **UPDATE this contract immediately** when adding new variables
6. **CROSS-REFERENCE:**
   - THIRD_PARTY_INTEGRATIONS.md for service API keys
   - FEATURES_CONTRACT.md for feature flags
   - DATABASE_SCHEMA_CONTRACT.md for database config
7. **ADD to `.env.example`** when adding new required variables
8. **DOCUMENT default values** and examples
9. **SPECIFY which modules use** each variable
10. **INCREMENT version number** for any infrastructure changes

### Workflow to Prevent Duplicate Configuration:

```
BEFORE ADDING ANY ENVIRONMENT VARIABLE:

1. Read INFRA_CONTRACT.md completely
2. Search for existing variables by:
   - Category (DATABASE_, REDIS_, AWS_, etc.)
   - Purpose (authentication, caching, storage)
   - Service name (SendGrid, Stripe, etc.)

3. If similar variable exists:
   ❌ DO NOT create duplicate variable
   ✅ USE the existing variable
   ✅ ADD your module to "Used By" column
   ✅ DOCUMENT your usage

4. If variable doesn't exist:
   ✅ FOLLOW naming convention
   ✅ ADD to appropriate category section
   ✅ DOCUMENT type, required, default, description, example
   ✅ LIST which modules use it
   ✅ ADD to .env.example
   ✅ CROSS-REFERENCE related contracts
   ✅ INCREMENT version number
   ✅ ADD changelog entry

5. For third-party services:
   ✅ CHECK THIRD_PARTY_INTEGRATIONS.md first
   ✅ ENSURE service is documented there
   ✅ CROSS-REFERENCE both contracts
```

### Common Mistakes to Avoid:

❌ **DON'T:**
- Create `SENDGRID_KEY` when `SENDGRID_API_KEY` exists
- Create `DB_URL` when `DATABASE_URL` exists
- Create `REDIS_URI` when `REDIS_URL` exists
- Hardcode values in code instead of using env vars
- Commit `.env` file to git
- Use inconsistent naming (mix of snake_case, camelCase)
- Add env vars without documenting them

✅ **DO:**
- Search this contract first
- Reuse existing variables
- Follow naming convention
- Document thoroughly
- Update .env.example
- Cross-reference other contracts
- Use descriptive names

### Benefits:

✅ **Single Source of Truth** - All config in one place  
✅ **No Duplicate Variables** - Prevents multiple names for same config  
✅ **No Conflicts** - Agents don't overwrite each other's config  
✅ **Consistent Naming** - Easy to find and understand  
✅ **Easy Onboarding** - New developers know all config options  
✅ **Security** - Centralized secrets management  
✅ **Documentation** - Every variable documented with examples  

---

## Initial Population Instructions

**For DevOps Agent / Coding Agents:**

When populating this template for the first time:

### Phase 1: Discover All Environment Variables

1. **Search codebase for `process.env`:**
   ```bash
   grep -r "process.env" src/ --include="*.js"
   ```

2. **Check configuration files:**
   - `config/*.js`
   - `.env.example`
   - `docker-compose.yml`
   - CI/CD config files

3. **Review third-party integrations:**
   - Check THIRD_PARTY_INTEGRATIONS.md
   - Look for API client initialization
   - Find authentication code

4. **Scan for hardcoded values:**
   - Database connection strings
   - API endpoints
   - Secret keys (security issue!)

### Phase 2: Categorize Variables

1. **Group by category:**
   - Application (APP_*)
   - Database (DATABASE_*)
   - Cache (REDIS_*)
   - Authentication (JWT_*)
   - Third-party services
   - Feature flags (FEATURE_*)
   - Logging (LOG_*)

2. **Document each variable:**
   - Name
   - Type (string, integer, boolean)
   - Required or optional
   - Default value
   - Description
   - Example
   - Which modules use it

### Phase 3: Create Configuration Files

1. **Generate `.env.example`:**
   - Include all variables
   - Use placeholder values
   - Add comments for clarity

2. **Document config files:**
   - List all `config/*.js` files
   - Show which env vars they use
   - Provide code examples

### Phase 4: Cross-Reference Contracts

1. **Link to THIRD_PARTY_INTEGRATIONS.md:**
   - For each service, link to its integration doc
   - Ensure API keys are documented in both places

2. **Link to FEATURES_CONTRACT.md:**
   - For each feature flag, link to the feature
   - Ensure features document their config needs

3. **Link to DATABASE_SCHEMA_CONTRACT.md:**
   - For database config, link to schema doc

**Search Patterns:**
- `process.env.`
- `config/*.js`
- `.env.example`, `.env.production`
- `docker-compose.yml`
- CI/CD configs: `.github/workflows/`, `.gitlab-ci.yml`

---

*This contract is a living document. Update it with every infrastructure change.*
