import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// We need to dynamically import and clear env vars before each test
// The module uses process.env directly, so we need to manipulate it

describe('PortConfig - KANVAS_PORT', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear both env vars to start clean
    delete process.env.KANVAS_PORT;
    delete process.env.KANVAS_PORT_RANGE;
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  it('KANVAS_PORT=6000 makes 6000 the preferred port', async () => {
    process.env.KANVAS_PORT = '6000';

    // Dynamically import to pick up env changes
    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.port).toBe(6000);
  });

  it('KANVAS_PORT with whitespace is trimmed', async () => {
    process.env.KANVAS_PORT = ' 7000 ';

    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.port).toBe(7000);
  });

  it('KANVAS_PORT with non-numeric value falls back to default', async () => {
    process.env.KANVAS_PORT = 'abc';

    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.port).toBe(5173);
  });
});

describe('PortConfig - range', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.KANVAS_PORT;
    delete process.env.KANVAS_PORT_RANGE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('KANVAS_PORT_RANGE=5200-5210 keeps the chosen port inside that range', async () => {
    process.env.KANVAS_PORT = '5205';
    process.env.KANVAS_PORT_RANGE = '5200-5210';

    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.port).toBe(5205);
    expect(config.range.start).toBe(5200);
    expect(config.range.end).toBe(5210);
  });

  it('malformed range (non-numeric) falls back to the defaults', async () => {
    process.env.KANVAS_PORT = '6000';
    process.env.KANVAS_PORT_RANGE = 'abc-def';

    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.port).toBe(6000);
    expect(config.range.start).toBe(5173);
    expect(config.range.end).toBe(5183);
  });

  it('malformed range (missing end) falls back to the defaults', async () => {
    process.env.KANVAS_PORT_RANGE = '5200-';

    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.port).toBe(5173);
    expect(config.range.start).toBe(5173);
    expect(config.range.end).toBe(5183);
  });

  it('malformed range (start > end) falls back to the defaults', async () => {
    process.env.KANVAS_PORT_RANGE = '5210-5200';

    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.port).toBe(5173);
    expect(config.range.start).toBe(5173);
    expect(config.range.end).toBe(5183);
  });

  it('KANVAS_PORT_RANGE with whitespace is trimmed', async () => {
    process.env.KANVAS_PORT_RANGE = ' 5200 - 5210 ';

    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.range.start).toBe(5200);
    expect(config.range.end).toBe(5210);
  });
});

describe('PortConfig - default', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.KANVAS_PORT;
    delete process.env.KANVAS_PORT_RANGE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('with neither variable set, defaults are port 5173 and range 5173-5183', async () => {
    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.port).toBe(5173);
    expect(config.range.start).toBe(5173);
    expect(config.range.end).toBe(5183);
  });

  it('default range is applied when KANVAS_PORT is set but KANVAS_PORT_RANGE is unset', async () => {
    process.env.KANVAS_PORT = '6000';

    const { getPortConfig } = await import('../../../shared/kanvas-port-config.js');
    const config = getPortConfig();

    expect(config.port).toBe(6000);
    // According to the operator ruling: with KANVAS_PORT set and KANVAS_PORT_RANGE unset,
    // the default range does not apply. The config should still return the default range
    // but the port (6000) is outside it, which is correct per the ruling.
    expect(config.range.start).toBe(5173);
    expect(config.range.end).toBe(5183);
  });
});
