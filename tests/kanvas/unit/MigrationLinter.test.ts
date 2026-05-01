/**
 * Unit Tests for P4 — Migration linter
 */

import { describe, it, expect } from '@jest/globals';
import { hasErrors, lintMigration } from '../../../shared/migration-linter';

const goodMigration = `-- UP
CREATE TABLE users (id INT PRIMARY KEY);

-- DOWN
DROP TABLE users;
`;

describe('lintMigration — naming (P4)', () => {
  it('errors when filename does not match `<ts>_<snake>.<ext>`', () => {
    const f = lintMigration({ fileName: 'addUsers.sql', contents: goodMigration });
    expect(f.some((x) => x.rule === 'naming/invalid' && x.severity === 'error')).toBe(true);
  });

  it('passes naming when format is correct', () => {
    const f = lintMigration({ fileName: '20260501120000_add_users.sql', contents: goodMigration });
    expect(f.some((x) => x.rule === 'naming/invalid')).toBe(false);
  });

  it('errors when extension is not in allowedExtensions', () => {
    const f = lintMigration({
      fileName: '20260501120000_add_users.sql',
      contents: goodMigration,
      allowedExtensions: ['py'],
    });
    expect(f.some((x) => x.rule === 'naming/extension' && x.severity === 'error')).toBe(true);
  });
});

describe('lintMigration — reversibility (P4)', () => {
  it('errors when no down section + not annotated irreversible', () => {
    const f = lintMigration({
      fileName: '20260501120000_add_users.sql',
      contents: '-- UP\nCREATE TABLE foo (id INT);\n',
    });
    expect(f.some((x) => x.rule === 'reversibility/missing-down' && x.severity === 'error')).toBe(true);
  });

  it('passes when -- DOWN is present', () => {
    const f = lintMigration({ fileName: '20260501120000_add_users.sql', contents: goodMigration });
    expect(f.some((x) => x.rule === 'reversibility/missing-down')).toBe(false);
  });

  it('passes when annotated -- @irreversible', () => {
    const f = lintMigration({
      fileName: '20260501120000_drop_legacy.sql',
      contents:
        '-- @irreversible legacy column removed; data already exported\n' +
        '-- @allow-destructive: cleanup post-export\n' +
        'DROP TABLE legacy_users;\n',
    });
    expect(f.some((x) => x.rule === 'reversibility/missing-down')).toBe(false);
  });
});

describe('lintMigration — destructive ops (P4)', () => {
  it('errors on DROP TABLE without @allow-destructive', () => {
    const f = lintMigration({
      fileName: '20260501120000_drop_legacy.sql',
      contents: '-- @irreversible\nDROP TABLE legacy_users;\n',
    });
    const hit = f.find((x) => x.rule === 'destructive/drop-table');
    expect(hit?.severity).toBe('error');
    expect(hit?.line).toBe(2);
  });

  it('downgrades to info when @allow-destructive is present', () => {
    const f = lintMigration({
      fileName: '20260501120000_drop_legacy.sql',
      contents: '-- @irreversible\n-- @allow-destructive: data exported\nDROP TABLE legacy_users;\n',
    });
    const hit = f.find((x) => x.rule === 'destructive/drop-table');
    expect(hit?.severity).toBe('info');
  });

  it('flags TRUNCATE', () => {
    const f = lintMigration({
      fileName: '20260501120000_purge.sql',
      contents: '-- DOWN\n-- nothing\n-- UP\nTRUNCATE audit_log;\n',
    });
    expect(f.some((x) => x.rule === 'destructive/truncate' && x.severity === 'error')).toBe(true);
  });

  it('flags DELETE without WHERE', () => {
    const f = lintMigration({
      fileName: '20260501120000_purge.sql',
      contents: '-- DOWN\n-- nothing\n-- UP\nDELETE FROM audit_log;\n',
    });
    expect(f.some((x) => x.rule === 'destructive/delete-without-where' && x.severity === 'error')).toBe(true);
  });

  it('does NOT flag DELETE WHERE …', () => {
    const f = lintMigration({
      fileName: '20260501120000_cleanup.sql',
      contents: "-- DOWN\n-- noop\n-- UP\nDELETE FROM audit_log WHERE created_at < '2025-01-01';\n",
    });
    expect(f.some((x) => x.rule === 'destructive/delete-without-where')).toBe(false);
  });

  it('flags ALTER TABLE … DROP COLUMN', () => {
    const f = lintMigration({
      fileName: '20260501120000_drop_col.sql',
      contents: '-- @irreversible\nALTER TABLE users DROP COLUMN legacy_field;\n',
    });
    expect(f.some((x) => x.rule === 'destructive/drop-column' && x.severity === 'error')).toBe(true);
  });
});

describe('hasErrors (P4)', () => {
  it('true when any error finding exists', () => {
    expect(hasErrors([{ rule: 'r', severity: 'error', line: 1, message: 'm' }])).toBe(true);
  });
  it('false when only warnings/info', () => {
    expect(
      hasErrors([
        { rule: 'r', severity: 'warning', line: 1, message: 'm' },
        { rule: 'r', severity: 'info', line: 1, message: 'm' },
      ])
    ).toBe(false);
  });
});
