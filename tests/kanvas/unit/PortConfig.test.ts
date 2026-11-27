import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { getKanvasPortConfig } from '../../../shared/kanvas-port-config.js';

// Helper to set environment variables and restore them
function setEnvVar(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('getKanvasPortConfig', () => {
  let originalPort: string | undefined;
  let originalRange: string | undefined;

  beforeEach(() => {
    originalPort = process.env.KANVAS_PORT;
    originalRange = process.env.KANVAS_PORT_RANGE;
  });

  afterEach(() => {
    setEnvVar('KANVAS_PORT', originalPort);
    setEnvVar('KANVAS_PORT_RANGE', originalRange);
  });

  describe('AC1: KANVAS_PORT sets the preferred port', () => {
    it('KANVAS_PORT=6000 makes 6000 the preferred port', () => {
      setEnvVar('KANVAS_PORT', '6000');
      setEnvVar('KANVAS_PORT_RANGE', undefined);

      const config = getKanvasPortConfig();

      expect(config.port).toBe(6000);
      expect(config.range).toEqual({ start: 5173, end: 5183 });
    });

    it('KANVAS_PORT=3000 makes 3000 the preferred port', () => {
      setEnvVar('KANVAS_PORT', '3000');
      setEnvVar('KANVAS_PORT_RANGE', undefined);

      const config = getKanvasPortConfig();

      expect(config.port).toBe(3000);
    });

    it('KANVAS_PORT takes precedence when both are set', () => {
      setEnvVar('KANVAS_PORT', '8080');
      setEnvVar('KANVAS_PORT_RANGE', '5200-5210');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(8080);
      expect(config.range).toEqual({ start: 5200, end: 5210 });
    });
  });

  describe('AC2: KANVAS_PORT_RANGE keeps the chosen port inside the range', () => {
    it('KANVAS_PORT_RANGE=5200-5210 sets the range correctly', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', '5200-5210');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(5200); // Start of range when KANVAS_PORT is unset
      expect(config.range).toEqual({ start: 5200, end: 5210 });
    });

    it('KANVAS_PORT_RANGE=6000-6100 with KANVAS_PORT=6050', () => {
      setEnvVar('KANVAS_PORT', '6050');
      setEnvVar('KANVAS_PORT_RANGE', '6000-6100');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(6050);
      expect(config.range).toEqual({ start: 6000, end: 6100 });
    });

    it('malformed range (non-numeric) falls back to defaults', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', 'abc-def');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(5173);
      expect(config.range).toEqual({ start: 5173, end: 5183 });
    });

    it('malformed range (wrong format - single number) falls back to defaults', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', '5200');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(5173);
      expect(config.range).toEqual({ start: 5173, end: 5183 });
    });

    it('malformed range (start > end) falls back to defaults', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', '5210-5200');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(5173);
      expect(config.range).toEqual({ start: 5173, end: 5183 });
    });

    it('malformed range (empty string) falls back to defaults', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', '');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(5173);
      expect(config.range).toEqual({ start: 5173, end: 5183 });
    });

    it('malformed range (extra dashes) falls back to defaults', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', '5200-5210-5220');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(5173);
      expect(config.range).toEqual({ start: 5173, end: 5183 });
    });
  });

  describe('AC3: Defaults when neither variable is set', () => {
    it('with neither KANVAS_PORT nor KANVAS_PORT_RANGE set, defaults are port 5173 and range 5173-5183', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', undefined);

      const config = getKanvasPortConfig();

      expect(config.port).toBe(5173);
      expect(config.range).toEqual({ start: 5173, end: 5183 });
    });

    it('default range has 11 ports (5173 through 5183 inclusive)', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', undefined);

      const config = getKanvasPortConfig();

      const rangeSize = config.range.end - config.range.start + 1;
      expect(rangeSize).toBe(11);
    });
  });

  describe('AC5: Pure function behavior for all combinations', () => {
    it('is a pure function - same inputs produce same outputs', () => {
      setEnvVar('KANVAS_PORT', '7000');
      setEnvVar('KANVAS_PORT_RANGE', '7000-7050');

      const config1 = getKanvasPortConfig();
      const config2 = getKanvasPortConfig();

      expect(config1).toEqual(config2);
      expect(config1.port).toBe(7000);
      expect(config1.range).toEqual({ start: 7000, end: 7050 });
    });

    it('handles KANVAS_PORT without KANVAS_PORT_RANGE', () => {
      setEnvVar('KANVAS_PORT', '9000');
      setEnvVar('KANVAS_PORT_RANGE', undefined);

      const config = getKanvasPortConfig();

      expect(config.port).toBe(9000);
      expect(config.range).toEqual({ start: 5173, end: 5183 });
    });

    it('handles KANVAS_PORT_RANGE without KANVAS_PORT', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', '8000-8100');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(8000); // Start of range
      expect(config.range).toEqual({ start: 8000, end: 8100 });
    });

    it('handles both variables set correctly', () => {
      setEnvVar('KANVAS_PORT', '4000');
      setEnvVar('KANVAS_PORT_RANGE', '3000-5000');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(4000);
      expect(config.range).toEqual({ start: 3000, end: 5000 });
    });

    it('handles whitespace in KANVAS_PORT', () => {
      setEnvVar('KANVAS_PORT', '  5555  ');
      setEnvVar('KANVAS_PORT_RANGE', undefined);

      const config = getKanvasPortConfig();

      expect(config.port).toBe(5555);
    });

    it('handles whitespace in KANVAS_PORT_RANGE', () => {
      setEnvVar('KANVAS_PORT', undefined);
      setEnvVar('KANVAS_PORT_RANGE', '  6000-6050  ');

      const config = getKanvasPortConfig();

      expect(config.port).toBe(6000);
      expect(config.range).toEqual({ start: 6000, end: 6050 });
    });
  });
});
