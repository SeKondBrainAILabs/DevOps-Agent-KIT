/**
 * Base Service Class
 * Provides common functionality for all services
 */

import { BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import type { IpcResult } from '../../shared/types';

export abstract class BaseService extends EventEmitter {
  protected mainWindow: BrowserWindow | null = null;

  /**
   * Set the main window for IPC event emission
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Emit event to renderer process
   * Safely checks if window exists and is not destroyed before sending
   */
  protected emitToRenderer(channel: string, data: unknown): void {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(channel, data);
      }
    } catch (error) {
      // Window may have been destroyed between the check and the send
      console.warn(`[BaseService] Failed to emit to renderer on ${channel}:`, (error as Error).message);
    }
  }

  /**
   * Create a successful result
   */
  protected success<T>(data: T): IpcResult<T> {
    return { success: true, data };
  }

  /**
   * Create an error result
   */
  protected error<T>(code: string, message: string, details?: unknown): IpcResult<T> {
    return {
      success: false,
      error: { code, message, details },
    };
  }

  /**
   * Wrap async operation with error handling
   */
  protected async wrap<T>(
    operation: () => Promise<T>,
    errorCode: string
  ): Promise<IpcResult<T>> {
    try {
      const data = await operation();
      return this.success(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return this.error(errorCode, message, err);
    }
  }

  /**
   * Initialize the service (override in subclass if needed)
   */
  async initialize(): Promise<void> {
    // Override in subclass
  }

  /**
   * Cleanup on shutdown (override in subclass if needed)
   */
  async dispose(): Promise<void> {
    // Override in subclass
  }
}
