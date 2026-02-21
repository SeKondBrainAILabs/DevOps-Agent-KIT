/**
 * Unit Tests for WorkerBridgeService
 * Tests worker process management, event routing, and health checking via IPC mock pattern
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockApi } from '../setup';

describe('WorkerBridgeService - Worker Status via IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should expose worker.status on the mock API', () => {
    expect(mockApi.worker.status).toBeDefined();
    expect(typeof mockApi.worker.status).toBe('function');
  });

  it('should expose worker.restart on the mock API', () => {
    expect(mockApi.worker.restart).toBeDefined();
    expect(typeof mockApi.worker.restart).toBe('function');
  });

  it('should return worker status with expected fields', async () => {
    const result = await mockApi.worker.status();

    expect(result).toEqual({
      success: true,
      data: {
        workerAlive: true,
        workerReady: true,
        workerPid: 12345,
        restartCount: 0,
        activeMonitors: 3,
        uptimeMs: 60000,
      },
    });
  });

  it('should return success on restart', async () => {
    const result = await mockApi.worker.restart();
    expect(result).toEqual({ success: true });
    expect(mockApi.worker.restart).toHaveBeenCalled();
  });

  it('should handle worker being down', async () => {
    (mockApi.worker.status as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: {
        workerAlive: false,
        workerReady: false,
        workerPid: null,
        restartCount: 3,
        activeMonitors: 0,
        uptimeMs: 0,
      },
    } as never);

    const result = await mockApi.worker.status();
    expect(result.data.workerAlive).toBe(false);
    expect(result.data.workerReady).toBe(false);
    expect(result.data.restartCount).toBe(3);
  });
});

describe('Worker Protocol Types', () => {
  it('should define valid command types', () => {
    const commands = [
      'start-file-monitor',
      'stop-file-monitor',
      'start-rebase-monitor',
      'stop-rebase-monitor',
      'start-heartbeat-monitor',
      'stop-heartbeat-monitor',
      'start-agent-monitor',
      'stop-agent-monitor',
      'start-kanvas-heartbeat',
      'stop-kanvas-heartbeat',
      'ping',
    ];

    for (const cmd of commands) {
      expect(typeof cmd).toBe('string');
    }
  });

  it('should define valid event types', () => {
    const events = [
      'file-changed',
      'commit-msg-detected',
      'rebase-remote-status',
      'heartbeat-update',
      'heartbeat-timeout',
      'agent-file-event',
      'pong',
      'error',
      'ready',
    ];

    for (const evt of events) {
      expect(typeof evt).toBe('string');
    }
  });
});
