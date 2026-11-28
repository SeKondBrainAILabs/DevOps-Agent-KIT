import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Helper function under test - we'll import it after creating the file
import { resolveKanvasPort } from '../../../shared/kanvas-port-config';

describe('resolveKanvasPort', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('AC1 - KANVAS_PORT', () => {
    it('KANVAS_PORT=6000 makes 6000 the preferred port', () => {
      process.env.KANVAS_PORT = '6000';
      const result = resolveKanvasPort();
      expect(result.port).toBe(6000);
    });

    it('KANVAS_PORT with whitespace is trimmed and parsed', () => {
      process.env.KANVAS_PORT = ' 6000 ';
      const result = resolveKanvasPort();
      expect(result.port).toBe(6000);
    });

    it('KANVAS_PORT with non-numeric value falls back to default 5173', () => {
      process.env.KANVAS_PORT = 'abc';
      const result = resolveKanvasPort();
      expect(result.port).toBe(5173);
    });

    it('KANVAS_PORT=0 is valid (edge case)', () => {
      process.env.KANVAS_PORT = '0';
      const result = resolveKanvasPort();
      expect(result.port).toBe(0);
    });
  });

  describe('AC2 - KANVAS_PORT_RANGE', () => {
    it('KANVAS_PORT_RANGE=5200-5210 keeps the chosen port inside that range', () => {
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      const result = resolveKanvasPort();
      expect(result.rangeStart).toBe(5200);
      expect(result.rangeEnd).toBe(5210);
    });

    it('KANVAS_PORT with KANVAS_PORT_RANGE keeps port and applies range', () => {
      process.env.KANVAS_PORT = '6000';
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      const result = resolveKanvasPort();
      expect(result.port).toBe(6000);
      expect(result.rangeStart).toBe(5200);
      expect(result.rangeEnd).toBe(5210);
    });

    it('malformed range with missing end falls back to defaults', () => {
      process.env.KANVAS_PORT_RANGE = '5200-';
      const result = resolveKanvasPort();
      expect(result.rangeStart).toBe(5173);
      expect(result.rangeEnd).toBe(5183);
    });

    it('malformed range with missing start falls back to defaults', () => {
      process.env.KANVAS_PORT_RANGE = '-5210';
      const result = resolveKanvasPort();
      expect(result.rangeStart).toBe(5173);
      expect(result.rangeEnd).toBe(5183);
    });

    it('malformed range without dash falls back to defaults', () => {
      process.env.KANVAS_PORT_RANGE = '5200';
      const result = resolveKanvasPort();
      expect(result.rangeStart).toBe(5173);
      expect(result.rangeEnd).toBe(5183);
    });

    it('malformed range with non-numeric values falls back to defaults', () => {
      process.env.KANVAS_PORT_RANGE = 'abc-def';
      const result = resolveKanvasPort();
      expect(result.rangeStart).toBe(5173);
      expect(result.rangeEnd).toBe(5183);
    });

    it('KANVAS_PORT_RANGE with whitespace is trimmed', () => {
      process.env.KANVAS_PORT_RANGE = ' 5200-5210 ';
      const result = resolveKanvasPort();
      expect(result.rangeStart).toBe(5200);
      expect(result.rangeEnd).toBe(5210);
    });

    it('KANVAS_PORT_RANGE with start > end is still parsed (validation is caller\'s responsibility)', () => {
      process.env.KANVAS_PORT_RANGE = '5210-5200';
      const result = resolveKanvasPort();
      expect(result.rangeStart).toBe(5210);
      expect(result.rangeEnd).toBe(5200);
    });
  });

  describe('AC3 - defaults', () => {
    it('with neither variable set, defaults are port 5173 and range 5173-5183', () => {
      delete process.env.KANVAS_PORT;
      delete process.env.KANVAS_PORT_RANGE;
      const result = resolveKanvasPort();
      expect(result.port).toBe(5173);
      expect(result.rangeStart).toBe(5173);
      expect(result.rangeEnd).toBe(5183);
    });

    it('only KANVAS_PORT set uses default range', () => {
      process.env.KANVAS_PORT = '6000';
      delete process.env.KANVAS_PORT_RANGE;
      const result = resolveKanvasPort();
      expect(result.port).toBe(6000);
      expect(result.rangeStart).toBe(5173);
      expect(result.rangeEnd).toBe(5183);
    });

    it('only KANVAS_PORT_RANGE set uses default port', () => {
      delete process.env.KANVAS_PORT;
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      const result = resolveKanvasPort();
      expect(result.port).toBe(5173);
      expect(result.rangeStart).toBe(5200);
      expect(result.rangeEnd).toBe(5210);
    });
  });
});

describe('AC4 - electron.vite.config.ts resolves its port through the helper', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.resetModules();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses the port from resolveKanvasPort for the renderer dev server', async () => {
    // The real electron.vite.config.ts pulls in electron-vite/vite/esbuild,
    // which cannot run under jsdom. Mock only those heavy build-time modules so
    // the production config module itself is imported and executed for real.
    jest.doMock('electron-vite', () => ({
      defineConfig: (config: unknown) => config,
      externalizeDepsPlugin: () => ({}),
    }));
    jest.doMock('@vitejs/plugin-react', () => ({ __esModule: true, default: () => ({}) }));
    // detect-port returns the requested port unchanged when it is free, so the
    // resolved server port reflects the port the config asked for.
    jest.doMock('detect-port', () => ({ __esModule: true, default: async (port: number) => port }));

    process.env.KANVAS_PORT = '6000';
    delete process.env.KANVAS_PORT_RANGE;

    const configModule = await import('../../../electron.vite.config');
    const config = (await (configModule.default as () => Promise<any>)()) as any;

    expect(config.renderer.server.port).toBe(6000);
  });
});
