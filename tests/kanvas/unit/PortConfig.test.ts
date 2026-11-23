/**
 * Unit Tests for Port Configuration Helper
 * Tests KANVAS_PORT and KANVAS_PORT_RANGE environment variable parsing
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock the environment before importing
const originalEnv = process.env;

describe('PortConfig', () => {
  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
    delete process.env.KANVAS_PORT;
    delete process.env.KANVAS_PORT_RANGE;
    
    // Clear any cached module
    jest.resetModules();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('KANVAS_PORT', () => {
    it('should parse KANVAS_PORT=6000 and make 6000 the preferred port', async () => {
      process.env.KANVAS_PORT = '6000';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(6000);
    });

    it('should parse KANVAS_PORT as an integer', async () => {
      process.env.KANVAS_PORT = '8080';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(8080);
      expect(typeof config.preferredPort).toBe('number');
    });

    it('should handle KANVAS_PORT with trailing newline', async () => {
      process.env.KANVAS_PORT = '7000\n';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(7000);
    });
  });

  describe('range', () => {
    it('should parse KANVAS_PORT_RANGE=5200-5210 correctly', async () => {
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5200);
      expect(config.portRange.end).toBe(5210);
    });

    it('should keep the chosen port inside KANVAS_PORT_RANGE=5200-5210 when preferredPort is outside', async () => {
      // Set preferred port to 5173 (default) but range to 5200-5210
      // The implementation should adjust preferredPort to be inside the range
      process.env.KANVAS_PORT = '5173';
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      // When preferredPort (5173) is outside the range (5200-5210),
      // it should be adjusted to portRange.start
      expect(config.preferredPort).toBe(5200);
      expect(config.portRange.start).toBe(5200);
      expect(config.portRange.end).toBe(5210);
    });

    it('should keep preferredPort unchanged when it is already inside the range', async () => {
      process.env.KANVAS_PORT = '5205';
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      // 5205 is inside 5200-5210, so it should stay unchanged
      expect(config.preferredPort).toBe(5205);
      expect(config.portRange.start).toBe(5200);
      expect(config.portRange.end).toBe(5210);
    });

    it('should handle KANVAS_PORT_RANGE where preferredPort is above the range', async () => {
      process.env.KANVAS_PORT = '5300';
      process.env.KANVAS_PORT_RANGE = '5200-5210';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      // 5300 is above 5210, so preferredPort should be adjusted to range.start
      expect(config.preferredPort).toBe(5200);
    });

    it('should handle malformed range format and fall back to defaults', async () => {
      process.env.KANVAS_PORT_RANGE = 'invalid';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      // Should fall back to defaults
      expect(config.preferredPort).toBe(5173);
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should handle malformed range with non-numeric values', async () => {
      process.env.KANVAS_PORT_RANGE = 'abc-def';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      // Should fall back to defaults
      expect(config.preferredPort).toBe(5173);
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should handle malformed range with missing end value', async () => {
      process.env.KANVAS_PORT_RANGE = '5200-';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      // Should fall back to defaults
      expect(config.preferredPort).toBe(5173);
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should handle malformed range with missing start value', async () => {
      process.env.KANVAS_PORT_RANGE = '-5210';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      // Should fall back to defaults
      expect(config.preferredPort).toBe(5173);
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });
  });

  describe('default', () => {
    it('should use default port 5173 when KANVAS_PORT is not set', async () => {
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(5173);
    });

    it('should use default range 5173-5183 when KANVAS_PORT_RANGE is not set', async () => {
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should use both defaults when neither variable is set', async () => {
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(5173);
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });

    it('should handle empty KANVAS_PORT as unset and use default', async () => {
      process.env.KANVAS_PORT = '';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      expect(config.preferredPort).toBe(5173);
    });

    it('should handle empty KANVAS_PORT_RANGE as unset and use default range', async () => {
      process.env.KANVAS_PORT_RANGE = '';
      
      const { getPortConfig } = await import('../../../shared/portConfig');
      const config = getPortConfig();
      
      expect(config.portRange.start).toBe(5173);
      expect(config.portRange.end).toBe(5183);
    });
  });
});
