import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// We need to dynamically import to control env vars between tests
let portConfigModule: typeof import('../../../shared/portConfig.js');

describe('PortConfig', () => {
  beforeEach(async () => {
    // Clear the module cache so we can reimport with different env vars
    jest.resetModules();
    portConfigModule = await import('../../../shared/portConfig.js');
  });

  describe('KANVAS_PORT', () => {
    beforeEach(() => {
      process.env.KANVAS_PORT = '6000';
      process.env.KANVAS_PORT_RANGE = '';
    });

    afterEach(() => {
      delete process.env.KANVAS_PORT;
      delete process.env.KANVAS_PORT_RANGE;
    });

    it('should make 6000 the preferred port when KANVAS_PORT=6000', async () => {
      // Re-import after setting env var
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(6000);
    });

    it('should respect different KANVAS_PORT values', async () => {
      process.env.KANVAS_PORT = '8080';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(8080);
    });

    it('should handle KANVAS_PORT with invalid number by falling back to default', async () => {
      process.env.KANVAS_PORT = 'invalid';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      // Invalid port should fall back to default 5173
      expect(config.preferredPort).toBe(5173);
    });

    it('should handle KANVAS_PORT with negative number by falling back to default', async () => {
      process.env.KANVAS_PORT = '-100';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(5173);
    });
  });

  describe('range', () => {
    beforeEach(() => {
      process.env.KANVAS_PORT = '';
    });

    afterEach(() => {
      delete process.env.KANVAS_PORT;
      delete process.env.KANVAS_PORT_RANGE;
    });

    it('should keep the chosen port inside KANVAS_PORT_RANGE=5200-5210', async () => {
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5200);
      expect(config.portRange.end).toBe(5210);
      // The chosen/preferred port must be within the configured range
      // When KANVAS_PORT is unset but KANVAS_PORT_RANGE is set, 
      // preferredPort should be adjusted to be within [range.start, range.end]
      expect(config.preferredPort).toBeGreaterThanOrEqual(config.portRange.start);
      expect(config.preferredPort).toBeLessThanOrEqual(config.portRange.end);
    });

    it('should fall back to defaults when range is malformed (no dash)', async () => {
      process.env.KANVAS_PORT_RANGE = '5200';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should fall back to defaults when range has non-numeric values', async () => {
      process.env.KANVAS_PORT_RANGE = 'abc-def';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should fall back to defaults when start > end', async () => {
      process.env.KANVAS_PORT_RANGE = '5210-5200';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should fall back to defaults when range has multiple dashes', async () => {
      process.env.KANVAS_PORT_RANGE = '5200-5210-extra';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should fall back to defaults when range is empty string', async () => {
      process.env.KANVAS_PORT_RANGE = '';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should handle range with negative numbers by falling back to defaults', async () => {
      process.env.KANVAS_PORT_RANGE = '-100--50';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });
  });

  describe('default', () => {
    afterEach(() => {
      delete process.env.KANVAS_PORT;
      delete process.env.KANVAS_PORT_RANGE;
    });

    it('should use port 5173 and range 5173-5183 when neither variable is set', async () => {
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(5173);
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should use default port when KANVAS_PORT is empty string', async () => {
      process.env.KANVAS_PORT = '';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(5173);
    });

    it('should use default range when KANVAS_PORT_RANGE is empty string', async () => {
      process.env.KANVAS_PORT_RANGE = '';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });
  });

  describe('combined behavior', () => {
    afterEach(() => {
      delete process.env.KANVAS_PORT;
      delete process.env.KANVAS_PORT_RANGE;
    });

    it('should respect both KANVAS_PORT and KANVAS_PORT_RANGE when set together', async () => {
      process.env.KANVAS_PORT = '6000';
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(6000);
      expect(config.portRange.start).toBe(5200);
      expect(config.portRange.end).toBe(5210);
    });

    it('should use custom port with default range when only KANVAS_PORT is set', async () => {
      process.env.KANVAS_PORT = '8080';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(8080);
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should use default port with custom range when only KANVAS_PORT_RANGE is set', async () => {
      process.env.KANVAS_PORT_RANGE = '9000-9010';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      const config = getPortConfig();
      
      // When KANVAS_PORT is unset but KANVAS_PORT_RANGE is set,
      // and the default port (5173) is outside the range,
      // preferredPort should be adjusted to range.start (9000)
      expect(config.preferredPort).toBe(9000);
      expect(config.portRange.start).toBe(9000);
      expect(config.portRange.end).toBe(9010);
    });
  });

  describe('AC4 integration with electron.vite.config', () => {
    afterEach(() => {
      delete process.env.KANVAS_PORT;
      delete process.env.KANVAS_PORT_RANGE;
    });

    it('should verify getPortConfig helper exports are correctly consumable by electron.vite.config.ts', async () => {
      // AC4: electron.vite.config.ts resolves its port through the helper
      // This test verifies the helper provides the correct configuration structure
      // that electron.vite.config.ts consumes via `const { preferredPort } = getPortConfig()`
      process.env.KANVAS_PORT = '6000';
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      jest.resetModules();
      const { getPortConfig } = await import('../../../shared/portConfig.js');
      
      // Verify the helper returns the expected structure that electron.vite.config.ts destructures
      const config = getPortConfig();
      
      // electron.vite.config.ts uses `const { preferredPort } = getPortConfig()`
      expect(config).toHaveProperty('preferredPort');
      expect(config).toHaveProperty('portRange');
      expect(typeof config.preferredPort).toBe('number');
      expect(typeof config.portRange.start).toBe('number');
      expect(typeof config.portRange.end).toBe('number');
      
      // Verify the values match the environment configuration
      expect(config.preferredPort).toBe(6000);
      expect(config.portRange.start).toBe(5200);
      expect(config.portRange.end).toBe(5210);
    });
  });
});
