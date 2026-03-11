# Seed Data Contract

**Last Updated:** 2026-03-07
**Version:** 1.0.0
**Status:** Initial Template

---

## Purpose

This contract documents **all seed data definitions for database initialization and test data**. Coding agents **MUST check this file before adding seed data** to:
- **Prevent duplicate seed entries** across features
- **Maintain correct insertion order** respecting foreign key dependencies
- **Ensure idempotent seeding** — safe to re-run without duplicating data
- **Separate environment-specific data** (dev, test, staging)
- **Centralize seed data management** across all features

---

## Change Log

| Date | Version | Agent/Author | Changes | Impact |
|------|---------|--------------|---------|--------|
| 2026-03-07 | 1.0.0 | DevOps Agent | Initial template creation | N/A - Template only |

---

## Seed Data Guidelines

### Idempotency Rules

1. **Use upsert patterns** — seed operations should use `ON CONFLICT DO UPDATE` or equivalent
2. **Define idempotency keys** — specify which columns uniquely identify a record
3. **Deterministic IDs** — prefer UUIDs or fixed IDs over auto-increment for seed data
4. **Checksum tracking** — each seed operation has a checksum; unchanged seeds are skipped on re-run

### Dependency Ordering

Seed data must declare table dependencies. The execution engine performs a **topological sort** to determine correct insertion order.

**Example:** If `orders` has a foreign key to `users`, then `users` must be seeded first.

### Environment Scoping

| Environment | Description | Typical Data |
|-------------|-------------|--------------|
| `dev` | Local development | Full sample data, test accounts, demo content |
| `test` | Automated test runs | Minimal data needed for test assertions |
| `staging` | Pre-production | Production-like data, anonymized |
| `production` | Live environment | Only essential lookup data (roles, categories) |

---

## Per-Feature Seed Definitions

### Feature: [Feature Name]

**Tables Seeded:**

| Table | Record Count | Dependencies | Idempotency Key | Environments |
|-------|-------------|--------------|-----------------|--------------|
| `table_name` | N | `dep_table` | `column_name` | dev, test |

**Sample Records:**

```json
{
  "table": "table_name",
  "data": [
    { "id": "uuid-1", "name": "Sample Record", "created_at": "2026-01-01" }
  ],
  "dependencies": ["dep_table"],
  "idempotencyKey": "id"
}
```

---

## Execution Plan

The merged execution plan (`SEED_EXECUTION_PLAN.json`) is generated automatically by combining all per-feature seed contracts. It contains:

1. **Ordered operations** — topologically sorted across all features
2. **Per-operation checksums** — for incremental re-seeding
3. **Rollback instructions** — reverse-order cleanup per table
4. **Metadata** — generation timestamp, totals, global checksum

---

## Startup Integration

Seed execution runs as part of the startup script which also:

1. **Discovers free ports** for each required service
2. **Writes port binding map** to `.S9N_KIT_DevOpsAgent/ports.json`
3. **Executes seed plan** with idempotency checks
4. **Reports status** via IPC channels to the renderer
