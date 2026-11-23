/**
 * KC-S1.2.2.1 — AC4: electron.vite.config.ts resolves its port through the
 * shared/portConfig helper and the app still builds.
 *
 * The config's default export is an async factory. These tests invoke that
 * factory with the port helper and detect-port mocked, and assert the renderer
 * server port the config actually returns:
 *  - it comes from the helper's getPortConfig() result (the range the helper
 *    returns constrains the chosen port), and
 *  - when the preferred port is busy it falls back to the first free port in
 *    the configured range, and
 *  - when no port in the range is free it throws an error naming the range.
 *
 * electron-vite and @vitejs/plugin-react are mocked so the config can be loaded
 * under jsdom without pulling in esbuild.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('electron-vite', () => ({
  defineConfig: (config: unknown) => config,
  externalizeDepsPlugin: () => ({}),
}));

jest.mock('@vitejs/plugin-react', () => ({
  __esModule: true,
  default: () => ({}),
}));

const getPortConfigMock = jest.fn(() => ({
  preferredPort: 5301,
  portRange: { start: 5300, end: 5302 },
}));

jest.mock('../../../shared/portConfig', () => ({
  __esModule: true,
  getPortConfig: getPortConfigMock,
}));

// Free ports are the ones detect-port returns unchanged. The default mock below
// treats every port as busy (returns p + 1); individual tests override it.
const detectPortMock = jest.fn(async (port: number) => port + 1);

jest.mock('detect-port', () => ({
  __esModule: true,
  default: (port: number) => detectPortMock(port),
}));

import configFactory from '../../../electron.vite.config';

async function resolveConfig(): Promise<any> {
  return (configFactory as unknown as () => Promise<any>)();
}

describe('electron.vite.config.ts port resolution (KC-S1.2.2.1 AC4)', () => {
  beforeEach(() => {
    getPortConfigMock.mockReset();
    getPortConfigMock.mockReturnValue({
      preferredPort: 5301,
      portRange: { start: 5300, end: 5302 },
    });
    detectPortMock.mockReset();
    detectPortMock.mockImplementation(async (port: number) => port + 1);
  });

  it('resolves its renderer port through the shared port helper', async () => {
    // The helper returns a range that does not contain the default 5173, so a
    // config that ignored the helper could not land inside it.
    getPortConfigMock.mockReturnValue({
      preferredPort: 5301,
      portRange: { start: 5300, end: 5302 },
    });
    detectPortMock.mockImplementation(async (port: number) => port);

    const config = await resolveConfig();

    expect(getPortConfigMock).toHaveBeenCalled();
    expect(config.renderer.server.port).toBeGreaterThanOrEqual(5300);
    expect(config.renderer.server.port).toBeLessThanOrEqual(5302);
  });

  it('uses the helper preferred port when it is free', async () => {
    getPortConfigMock.mockReturnValue({
      preferredPort: 5301,
      portRange: { start: 5300, end: 5302 },
    });
    detectPortMock.mockImplementation(async (port: number) => port);

    const config = await resolveConfig();

    expect(config.renderer.server.port).toBe(5301);
  });

  it('keeps the chosen port inside the helper range when the preferred port is busy', async () => {
    getPortConfigMock.mockReturnValue({
      preferredPort: 5301,
      portRange: { start: 5300, end: 5302 },
    });
    // Only 5300 is free; everything else reports the next port as available.
    detectPortMock.mockImplementation(async (port: number) =>
      port === 5300 ? 5300 : port + 1,
    );

    const config = await resolveConfig();

    expect(config.renderer.server.port).toBe(5300);
    expect(config.renderer.server.port).toBeGreaterThanOrEqual(5300);
    expect(config.renderer.server.port).toBeLessThanOrEqual(5302);
  });

  it('throws an error naming the range when no port in the helper range is free', async () => {
    getPortConfigMock.mockReturnValue({
      preferredPort: 5301,
      portRange: { start: 5300, end: 5302 },
    });
    // Every port is busy.
    detectPortMock.mockImplementation(async (port: number) => port + 1);

    await expect(resolveConfig()).rejects.toThrow(/5300-5302/);
  });
});
