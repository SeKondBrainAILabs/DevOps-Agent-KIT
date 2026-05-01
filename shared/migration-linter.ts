/**
 * Migration linter (Epic P / story P4).
 *
 * Pure rule engine for SQL / framework migrations. Catches the common
 * SB001-era foot-guns:
 *   1. Naming: file must be <timestamp>_<snake_case_name>.<ext>
 *   2. Reversibility: must declare a down() / -- DOWN section
 *      (unless explicitly marked irreversible)
 *   3. Destructive operations: DROP / TRUNCATE / DELETE without WHERE require
 *      an explicit `-- @allow-destructive: <reason>` annotation
 *
 * Returns structured findings; the service layer renders them and decides
 * whether to block the commit (errors) or just warn (warnings).
 */

export type MigrationSeverity = 'error' | 'warning' | 'info';

export interface MigrationFinding {
  rule: string;
  severity: MigrationSeverity;
  /** 1-based line number of the offending text (or 0 for file-level findings). */
  line: number;
  message: string;
}

export interface LintMigrationInputs {
  /** File name including extension (e.g. `20260501120000_add_users.sql`). */
  fileName: string;
  /** File contents. */
  contents: string;
  /** Override allowed extensions. Default: ['sql']. */
  allowedExtensions?: ReadonlyArray<string>;
}

const NAMING_RE = /^\d{8,}_[a-z0-9_]+\.[a-z]+$/;

const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ rule: string; re: RegExp; msg: string }> = [
  { rule: 'destructive/drop-table', re: /\bdrop\s+table\b/i, msg: 'DROP TABLE detected.' },
  { rule: 'destructive/drop-column', re: /\balter\s+table\s+\S+\s+drop\s+column\b/i, msg: 'ALTER TABLE … DROP COLUMN detected.' },
  { rule: 'destructive/truncate', re: /\btruncate\b/i, msg: 'TRUNCATE detected.' },
  // DELETE without WHERE clause — naive but catches the obvious cases.
  { rule: 'destructive/delete-without-where', re: /\bdelete\s+from\s+\S+\s*;/i, msg: 'DELETE without WHERE clause.' },
];

const ALLOW_DESTRUCTIVE_RE = /--\s*@allow-destructive\s*:\s*\S/i;
const IRREVERSIBLE_RE = /--\s*@irreversible\b/i;
const DOWN_SECTION_RE = /(--\s*DOWN\b)|(\bdown\s*:\s*\n)|(\bdef\s+down\b)|(\.down\s*=)/i;

export function lintMigration(input: LintMigrationInputs): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const allowedExt = input.allowedExtensions ?? ['sql'];

  // Rule 1: filename
  if (!NAMING_RE.test(input.fileName)) {
    findings.push({
      rule: 'naming/invalid',
      severity: 'error',
      line: 0,
      message:
        'Migration filename must be `<timestamp>_<snake_case_name>.<ext>` ' +
        '(e.g. `20260501120000_add_users.sql`).',
    });
  } else {
    const ext = input.fileName.split('.').pop()!.toLowerCase();
    if (!allowedExt.includes(ext)) {
      findings.push({
        rule: 'naming/extension',
        severity: 'error',
        line: 0,
        message: `Extension ".${ext}" is not allowed. Allowed: ${allowedExt.join(', ')}.`,
      });
    }
  }

  // Rule 2: reversibility
  const isIrreversible = IRREVERSIBLE_RE.test(input.contents);
  const hasDown = DOWN_SECTION_RE.test(input.contents);
  if (!isIrreversible && !hasDown) {
    findings.push({
      rule: 'reversibility/missing-down',
      severity: 'error',
      line: 0,
      message:
        'Migration has no `down` / `-- DOWN` section. Add one or annotate ' +
        'with `-- @irreversible <reason>` to bypass.',
    });
  }

  // Rule 3: destructive ops
  const allowsDestructive = ALLOW_DESTRUCTIVE_RE.test(input.contents);
  const lines = input.contents.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const pat of DESTRUCTIVE_PATTERNS) {
      if (pat.re.test(lines[i])) {
        if (allowsDestructive) {
          findings.push({
            rule: pat.rule,
            severity: 'info',
            line: i + 1,
            message: `${pat.msg} Allowed by \`@allow-destructive\`.`,
          });
        } else {
          findings.push({
            rule: pat.rule,
            severity: 'error',
            line: i + 1,
            message: `${pat.msg} Add \`-- @allow-destructive: <reason>\` if intentional.`,
          });
        }
      }
    }
  }

  return findings;
}

/** True when a finding list contains at least one error. */
export function hasErrors(findings: ReadonlyArray<MigrationFinding>): boolean {
  return findings.some((f) => f.severity === 'error');
}
