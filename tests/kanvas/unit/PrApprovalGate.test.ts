/**
 * Unit Tests for the optional PR approval gate (story KC-S1.2.2.3)
 *
 * Protected merges may optionally require `reviewDecision === 'APPROVED'`.
 * The setting is `merge.require_pr_approval` (AppConfig.mergeRequirePrApproval),
 * a boolean that defaults to false.
 *
 * These tests drive the real production code:
 *   - ConfigService.getMergeRequirePrApproval() for the default (AC2)
 *   - MergeService.executeMerge() on a protected target for the gate itself (AC1, AC3)
 *
 * `gh` is mocked at the shared/github-cli boundary and `git` at execa, so the
 * gate runs exactly as it would in the app without touching a real repo.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Mocks ────────────────────────────────────────────────────────────────────
// electron-store does not compile cleanly under ts-jest; a minimal in-memory
// store is enough for ConfigService's default/read paths.
jest.mock('electron-store', () => {
  return {
    __esModule: true,
    default: class MockStore<T> {
      private data: Record<string, unknown>;
      constructor(opts: any) {
        // Deep-ish clone so tests never share the module-level default object.
        this.data = JSON.parse(JSON.stringify(opts?.defaults ?? {}));
      }
      get(key: string) {
        return this.data[key];
      }
      set(key: string, value: unknown) {
        this.data[key] = value;
      }
    },
  };
});

// The gh runner is the seam MergeService uses for every `gh` call. Mocking
// createGhRunner (rather than execa) keeps classifyGhFailure real.
jest.mock('../../../shared/github-cli', () => {
  const actual = jest.requireActual('../../../shared/github-cli') as any;
  return { ...actual, createGhRunner: jest.fn() };
});

// git goes through execa. execa is ESM-only in this project, so mock it.
jest.mock('execa', () => ({ __esModule: true, execa: jest.fn() }));

import { createGhRunner } from '../../../shared/github-cli';
import { ConfigService } from '../../../electron/services/ConfigService';
import { MergeService } from '../../../electron/services/MergeService';

// ── Test doubles ─────────────────────────────────────────────────────────────

type GhCall = { args: string[] };

/**
 * Install a gh runner that answers the calls the merge gate makes:
 *   gh auth status                          → authenticated
 *   gh pr view <b> --json state,url         → an OPEN PR
 *   gh pr view <b> --json reviewDecision    → the supplied decision
 * Every call is recorded so a test can assert the approval check ran (or not).
 */
function installGh(reviewDecision: string | null): { calls: GhCall[] } {
  const calls: GhCall[] = [];
  (createGhRunner as any).mockImplementation(() =>
    async (args: string[]) => {
      calls.push({ args });
      if (args[0] === 'auth') {
        return { ok: true, stdout: 'logged in', stderr: '', code: 0 };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const json = args[args.length - 1];
        if (json === 'state,url') {
          return { ok: true, stdout: JSON.stringify({ state: 'OPEN', url: 'https://example/pr/1' }), stderr: '', code: 0 };
        }
        if (json === 'reviewDecision') {
          return { ok: true, stdout: JSON.stringify({ reviewDecision }), stderr: '', code: 0 };
        }
      }
      // gh pr checks / gh run list — no CI signal; the gate fails closed, but
      // the approval assertions below always fire before CI is reached.
      return { ok: true, stdout: '[]', stderr: '', code: 0 };
    }
  );
  return { calls };
}

/** Install a git double. `remote get-url` reports a GitHub remote so
 *  canOpenPullRequest() succeeds; everything else is a benign empty success. */
async function installGit(): Promise<void> {
  const execa = (await import('execa')).execa as any;
  execa.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: 'git@github.com:acme/widgets.git', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'log') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}

/** A MergeService whose config reports the given approval requirement. */
function mergeService(requirePrApproval: boolean): MergeService {
  const svc = new MergeService();
  svc.setConfigService({ getMergeRequirePrApproval: () => requirePrApproval });
  return svc;
}

const PROTECTED = 'main';
const SOURCE = 'feat/session-1';

// ============================================================================
// AC2: merge.require_pr_approval defaults to false
// ============================================================================

describe('PR Approval Gate — AC2: default', () => {
  it('AppConfig declares mergeRequirePrApproval so the setting is a typed contract', () => {
    // The setting must be part of the AppConfig contract, not an ad-hoc string
    // key. Without the declared member the config service cannot type-check
    // against it and the build fails. Read the real interface block.
    const source = readFileSync(resolve(__dirname, '../../../shared/types.ts'), 'utf-8');
    const start = source.indexOf('export interface AppConfig');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf('}', start));
    expect(body).toMatch(/mergeRequirePrApproval\s*\??\s*:\s*boolean/);
  });

  it('merge.require_pr_approval defaults to false', () => {
    // The default lives in ConfigService's defaultConfig. A fresh service —
    // nothing written yet — must report the setting as off.
    const config = new ConfigService();
    expect(config.getMergeRequirePrApproval()).toBe(false);
  });
});

// ============================================================================
// AC1: setting off vs on
// ============================================================================

describe('PR Approval Gate — AC1: setting off vs on', () => {
  beforeEach(async () => {
    await installGit();
  });

  it('setting OFF never consults the review decision and never refuses PR_NOT_APPROVED', async () => {
    // reviewDecision is deliberately NOT approved; with the setting off the
    // gate must not even ask, and must not refuse on approval grounds.
    const gh = installGh('CHANGES_REQUESTED');
    const svc = mergeService(false);

    const res = await svc.executeMerge('/repo', SOURCE, PROTECTED, { via: 'direct' });
    const data = (res as any).data;

    const askedReview = gh.calls.some(
      (c) => c.args[0] === 'pr' && c.args[1] === 'view' && c.args.includes('reviewDecision')
    );
    expect(askedReview).toBe(false);
    expect(data?.gateReason).not.toBe('PR_NOT_APPROVED');
  });

  it('setting ON refuses a non-APPROVED reviewDecision with PR_NOT_APPROVED and a message saying what to do', async () => {
    installGh('CHANGES_REQUESTED');
    const svc = mergeService(true);

    const res = await svc.executeMerge('/repo', SOURCE, PROTECTED, { via: 'direct' });

    expect(res.success).toBe(true); // IpcResult wrapper succeeded
    const data = (res as any).data;
    expect(data.success).toBe(false);
    expect(data.gateReason).toBe('PR_NOT_APPROVED');
    // The message must tell the user what to do: get it approved.
    expect(data.message).toMatch(/approve/i);
    expect(data.message).toMatch(/APPROVED/);
  });

  it('setting ON refuses a missing reviewDecision with PR_NOT_APPROVED', async () => {
    installGh(null);
    const svc = mergeService(true);

    const res = await svc.executeMerge('/repo', SOURCE, PROTECTED, { via: 'direct' });
    const data = (res as any).data;
    expect(data.success).toBe(false);
    expect(data.gateReason).toBe('PR_NOT_APPROVED');
  });

  it('setting ON allows an APPROVED reviewDecision through the approval gate', async () => {
    installGh('APPROVED');
    const svc = mergeService(true);

    const res = await svc.executeMerge('/repo', SOURCE, PROTECTED, { via: 'direct' });
    const data = (res as any).data;
    // The approval gate must not be the thing that stops it. The merge may
    // still fail later for unrelated, mocked-CI reasons — but never here.
    expect(data.gateReason).not.toBe('PR_NOT_APPROVED');
  });
});

// ============================================================================
// AC3: override + non-protected targets (behaviour guard)
// ============================================================================

describe('PR Approval Gate — AC3: override', () => {
  beforeEach(async () => {
    await installGit();
  });

  it('non-protected targets are unaffected by the approval gate even when the setting is ON', async () => {
    // A feature branch target is not protected, so the gate is never entered.
    const gh = installGh('CHANGES_REQUESTED');
    const svc = mergeService(true);

    const res = await svc.executeMerge('/repo', SOURCE, 'development', { via: 'direct' });
    const data = (res as any).data;

    expect(data.gateReason).not.toBe('PR_NOT_APPROVED');
    const askedReview = gh.calls.some(
      (c) => c.args[0] === 'pr' && c.args[1] === 'view' && c.args.includes('reviewDecision')
    );
    expect(askedReview).toBe(false);
  });

  it('skipCiGate override bypasses the approval gate on a protected target', async () => {
    // "Merge without CI check" is the existing escape hatch; it must also skip
    // the approval gate rather than being blocked by a second, new gate.
    const gh = installGh('CHANGES_REQUESTED');
    const svc = mergeService(true);

    const res = await svc.executeMerge('/repo', SOURCE, PROTECTED, {
      via: 'direct',
      skipCiGate: true,
    });
    const data = (res as any).data;

    expect(data.gateReason).not.toBe('PR_NOT_APPROVED');
    const askedReview = gh.calls.some(
      (c) => c.args[0] === 'pr' && c.args[1] === 'view' && c.args.includes('reviewDecision')
    );
    expect(askedReview).toBe(false);
  });

  it('protected target without override enforces the approval gate when the setting is ON', async () => {
    // The positive control for the two bypass tests above.
    installGh('CHANGES_REQUESTED');
    const svc = mergeService(true);

    const res = await svc.executeMerge('/repo', SOURCE, PROTECTED, { via: 'direct' });
    const data = (res as any).data;
    expect(data.success).toBe(false);
    expect(data.gateReason).toBe('PR_NOT_APPROVED');
  });
});
