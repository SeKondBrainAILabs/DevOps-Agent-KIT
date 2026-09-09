/**
 * E2E — Workspace Browser happy path (Epic A / Day 1)
 *
 * Launches the Electron app, opens the Workspace Browser via the
 * sidebar, adds a workspace pointing at this very repo's worktree
 * folder, and verifies the repo card appears.
 */

import { test, expect } from '@playwright/test';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  launchElectronApp,
  closeElectronApp,
  type ElectronTestContext,
} from './electron.setup';

let ctx: ElectronTestContext;

test.beforeAll(async () => {
  ctx = await launchElectronApp(false);
});

test.afterAll(async () => {
  if (ctx?.app) await closeElectronApp(ctx.app);
});

test('user can open Workspace Browser via sidebar nav', async () => {
  const { page } = ctx;

  // The Workspaces icon-rail button
  await page.locator('[data-testid="nav-workspaces"]').click();

  // The browser shell renders
  const browser = page.locator('[data-testid="workspace-browser"]');
  await expect(browser).toBeVisible();

  // Empty state appears (assuming clean test profile)
  const empty = page.locator('[data-testid="empty-state-no-workspace"]');
  await expect(empty).toBeVisible();
});

test('user can add a workspace and see discovered repos', async () => {
  const { page } = ctx;

  // Create a temp workspace folder with two fake git repos
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kanvas-e2e-'));
  await fs.mkdir(path.join(tmp, 'repo-a', '.git'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'repo-b', '.git'), { recursive: true });

  // Open Add Workspace
  await page.locator('[data-testid="nav-workspaces"]').click();
  await page.locator('[data-testid="add-workspace-button"]').click();

  await expect(page.locator('[data-testid="add-workspace-dialog"]')).toBeVisible();

  // Type the path manually (Browse uses a real OS dialog we can't drive in-app)
  await page.locator('[data-testid="workspace-path-input"]').fill(tmp);
  await page.locator('[data-testid="submit-button"]').click();

  // Dialog closes
  await expect(page.locator('[data-testid="add-workspace-dialog"]')).toBeHidden();

  // The workspace switcher now has an option for this workspace
  await expect(page.locator('[data-testid="workspace-switcher"] option')).toHaveCount(1);

  // Repo grid eventually shows both fake repos
  const grid = page.locator('[data-testid="repo-grid"]');
  await expect(grid).toBeVisible();
  await expect(grid.locator('[data-testid="repo-status-card"]')).toHaveCount(2);

  // Cleanup
  await fs.rm(tmp, { recursive: true, force: true });
});

test('filter narrows the list of repos', async () => {
  const { page } = ctx;
  // Assumes the previous test left a workspace + repos available; if test
  // isolation is needed, this can be hoisted to its own suite.
  await page.locator('[data-testid="nav-workspaces"]').click();
  await page.locator('[data-testid="repo-filter"]').fill('repo-a');
  await expect(
    page.locator('[data-testid="repo-grid"] [data-testid="repo-status-card"]')
  ).toHaveCount(1);
});
