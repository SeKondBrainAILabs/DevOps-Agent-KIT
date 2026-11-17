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
      
      expect(config.preferredPort).toBe(5173);
      expect(config.portRange.start).toBe(9000);
      expect(config.portRange.end).toBe(9010);
    });
  });
});
