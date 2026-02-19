/**
 * Unit Tests for AgentInstanceService.updateBaseBranch()
 * Tests the base branch update functionality via the IPC mock pattern
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockApi } from '../setup';

describe('AgentInstanceService - updateBaseBranch via IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should expose updateBaseBranch on the instance API', () => {
    expect(window.api.instance.updateBaseBranch).toBeDefined();
    expect(typeof window.api.instance.updateBaseBranch).toBe('function');
  });

  it('should call updateBaseBranch with correct parameters', async () => {
    const sessionId = 'sess_test_123';
    const newBranch = 'develop';

    await window.api.instance.updateBaseBranch(sessionId, newBranch);

    expect(mockApi.instance.updateBaseBranch).toHaveBeenCalledWith(sessionId, newBranch);
  });

  it('should return success result on valid branch change', async () => {
    const result = await window.api.instance.updateBaseBranch('sess_test_123', 'develop');

    expect(result).toEqual({ success: true });
  });

  it('should return error when branch not found', async () => {
    (mockApi.instance.updateBaseBranch as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: { code: 'BRANCH_NOT_FOUND', message: 'Branch "nonexistent" not found in repository' },
    } as never);

    const result = await window.api.instance.updateBaseBranch('sess_test_123', 'nonexistent');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('BRANCH_NOT_FOUND');
  });

  it('should return error when session not found', async () => {
    (mockApi.instance.updateBaseBranch as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'No instance found for session nonexistent' },
    } as never);

    const result = await window.api.instance.updateBaseBranch('nonexistent', 'main');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

describe('App API - reload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should expose reload on the app API', () => {
    expect(window.api.app.reload).toBeDefined();
    expect(typeof window.api.app.reload).toBe('function');
  });

  it('should call reload successfully', async () => {
    const result = await window.api.app.reload();
    expect(result).toEqual({ success: true });
    expect(mockApi.app.reload).toHaveBeenCalled();
  });
});
