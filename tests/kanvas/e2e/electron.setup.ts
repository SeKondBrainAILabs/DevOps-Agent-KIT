/**
 * Electron E2E Test Setup
 * Provides utilities for testing the Kanvas Electron app
 */

import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ElectronTestContext {
  app: ElectronApplication;
  page: Page;
}

/**
 * Launch the Electron app for testing
 * @param useRealData - If true, uses the real app database for integration tests
 */
export async function launchElectronApp(useRealData = false): Promise<ElectronTestContext> {
  // Build the app first if needed
  const appPath = path.resolve(__dirname, '../../../');

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
  };

  // Args for Electron
  const args = [path.join(appPath, 'dist/electron/index.js')];

  // For integration tests, use the real app data by specifying userData path
  // For unit-style E2E tests, use test mode
  if (useRealData) {
    // Point to the real app data directory
    const realUserDataPath = path.join(
      process.env.HOME || '',
      'Library/Application Support/kit-for-devops'
    );
    args.push(`--user-data-dir=${realUserDataPath}`);
  } else {
    env.NODE_ENV = 'test';
    env.KANVAS_TEST_MODE = 'true';
  }

  const app = await electron.launch({
    args,
    env,
  });

  // Wait for the first window
  const page = await app.firstWindow();

  // Wait for the app to be ready
  await page.waitForLoadState('domcontentloaded');

  // Give more time for real data mode to load sessions
  if (useRealData) {
    await page.waitForTimeout(3000);
  }

  return { app, page };
}

/**
 * Close the Electron app
 */
export async function closeElectronApp(app: ElectronApplication): Promise<void> {
  await app.close();
}

/**
 * Get the main window page
 */
export async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const windows = app.windows();
  return windows[0] || await app.firstWindow();
}

/**
 * Wait for element to be visible with custom timeout
 */
export async function waitForElement(
  page: Page,
  selector: string,
  timeout = 10000
): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout });
}

/**
 * Take a screenshot for debugging
 */
export async function takeScreenshot(
  page: Page,
  name: string
): Promise<void> {
  await page.screenshot({
    path: `test-results/screenshots/${name}-${Date.now()}.png`,
    fullPage: true,
  });
}

/**
 * Simulate clicking on a button by text
 */
export async function clickButtonByText(
  page: Page,
  text: string
): Promise<void> {
  await page.click(`button:has-text("${text}")`);
}

/**
 * Fill input by placeholder text
 */
export async function fillInputByPlaceholder(
  page: Page,
  placeholder: string,
  value: string
): Promise<void> {
  await page.fill(`input[placeholder*="${placeholder}"], textarea[placeholder*="${placeholder}"]`, value);
}

/**
 * Select option from dropdown
 */
export async function selectOption(
  page: Page,
  label: string,
  value: string
): Promise<void> {
  const select = page.locator(`select:near(:text("${label}"))`).first();
  await select.selectOption(value);
}

/**
 * Check if element exists
 */
export async function elementExists(
  page: Page,
  selector: string
): Promise<boolean> {
  const element = await page.$(selector);
  return element !== null;
}

/**
 * Wait for modal to appear
 */
export async function waitForModal(page: Page): Promise<void> {
  await page.waitForSelector('.modal', { state: 'visible' });
}

/**
 * Close modal by clicking backdrop or close button
 */
export async function closeModal(page: Page): Promise<void> {
  const closeButton = await page.$('.modal button:has-text("Cancel"), .modal button:has-text("Close"), .modal button:has-text("Done")');
  if (closeButton) {
    await closeButton.click();
  } else {
    await page.click('.modal-backdrop');
  }
  await page.waitForSelector('.modal', { state: 'hidden' });
}
