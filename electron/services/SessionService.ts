/**
 * Session Service
 * Manages DevOps agent sessions (create, list, close, claim)
 * Migrated from: session-coordinator.js + close-session.js
 */

import { BaseService } from './BaseService';
import { IPC } from '../../shared/ipc-channels';
import type {
  Session,
  CreateSessionRequest,
  CloseSessionRequest,
  IpcResult,
  SessionStatus,
  AgentType,
} from '../../shared/types';
import type { GitService } from './GitService';
import type { WatcherService } from './WatcherService';
import type { LockService } from './LockService';
import type { ActivityService } from './ActivityService';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// Session storage paths
const SESSION_DIR = path.join(os.homedir(), '.devops-agent', 'sessions');
const LOCK_DIR = path.join(os.homedir(), '.devops-agent', 'session-locks');

export class SessionService extends BaseService {
  private sessions: Map<string, Session> = new Map();
  private gitService: GitService;
  private watcherService: WatcherService;
  private lockService: LockService;
  private activityService: ActivityService;

  constructor(
    git: GitService,
    watcher: WatcherService,
    lock: LockService,
    activity: ActivityService
  ) {
    super();
    this.gitService = git;
    this.watcherService = watcher;
    this.lockService = lock;
    this.activityService = activity;
  }

  async initialize(): Promise<void> {
    // Ensure directories exist
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.mkdir(LOCK_DIR, { recursive: true });

    // Load existing sessions
    await this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    try {
      const files = await fs.readdir(SESSION_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = await fs.readFile(path.join(SESSION_DIR, file), 'utf8');
          const session = JSON.parse(content) as Session;
          this.sessions.set(session.id, session);
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  private generateSessionId(): string {
    return randomBytes(4).toString('hex');
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 30);
  }

  async create(request: CreateSessionRequest): Promise<IpcResult<Session>> {
    return this.wrap(async () => {
      const id = this.generateSessionId();
      const slug = this.slugify(request.task);
      const branchName = `session/${slug}-${id}`;
      const worktreePath = path.join(request.repoPath, '.worktrees', `${slug}-${id}`);

      // Create the session object
      const session: Session = {
        id,
        name: request.task,
        task: request.task,
        agentType: request.agentType,
        status: 'idle',
        branchName,
        worktreePath,
        repoPath: request.repoPath,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        commitCount: 0,
      };

      // Create worktree
      const worktreeResult = await this.gitService.createWorktree(
        id,
        branchName,
        worktreePath
      );
      if (!worktreeResult.success) {
        throw new Error(worktreeResult.error?.message || 'Failed to create worktree');
      }

      // Save session
      this.sessions.set(id, session);
      await this.saveSession(session);

      // Create lock file
      await this.createLockFile(session);

      // Emit event
      this.emitToRenderer(IPC.SESSION_CREATED, session);

      // Log activity
      this.activityService.log(id, 'success', `Session created: ${session.name}`);

      return session;
    }, 'SESSION_CREATE_FAILED');
  }

  async list(): Promise<IpcResult<Session[]>> {
    return this.success(Array.from(this.sessions.values()));
  }

  async get(id: string): Promise<IpcResult<Session | null>> {
    return this.success(this.sessions.get(id) || null);
  }

  async close(request: CloseSessionRequest): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const session = this.sessions.get(request.sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      // Stop watcher if running
      await this.watcherService.stop(request.sessionId);

      // Release file locks. Keyed by repo root — see LockService.declareFiles.
      if (session.repoPath) {
        await this.lockService.releaseFiles(session.repoPath, request.sessionId);
      }

      // Merge if requested
      if (request.merge && request.mergeTarget) {
        await this.gitService.merge(request.sessionId, request.mergeTarget);
      }

      // Remove worktree
      await this.gitService.removeWorktree(request.sessionId);

      // Update session status
      session.status = 'closed';
      session.updated = new Date().toISOString();

      // Remove from active sessions
      this.sessions.delete(request.sessionId);

      // Remove session file and lock
      await this.removeSessionFiles(session);

      // Emit event
      this.emitToRenderer(IPC.SESSION_CLOSED, request.sessionId);

      // Log activity
      this.activityService.log(request.sessionId, 'info', `Session closed: ${session.name}`);
    }, 'SESSION_CLOSE_FAILED');
  }

  async claim(sessionId: string): Promise<IpcResult<Session>> {
    return this.wrap(async () => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      // Update status to active
      session.status = 'active';
      session.updated = new Date().toISOString();
      await this.saveSession(session);

      // Emit update
      this.emitToRenderer(IPC.SESSION_UPDATED, session);

      return session;
    }, 'SESSION_CLAIM_FAILED');
  }

  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.updated = new Date().toISOString();
      await this.saveSession(session);
      this.emitToRenderer(IPC.SESSION_UPDATED, session);
    }
  }

  async incrementCommitCount(sessionId: string, commitHash: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.commitCount++;
      session.lastCommit = commitHash;
      session.updated = new Date().toISOString();
      await this.saveSession(session);
      this.emitToRenderer(IPC.SESSION_UPDATED, session);
    }
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  private async saveSession(session: Session): Promise<void> {
    const filePath = path.join(SESSION_DIR, `${session.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2));
  }

  private async createLockFile(session: Session): Promise<void> {
    const lockPath = path.join(LOCK_DIR, `${session.id}.lock`);
    const lockData = {
      sessionId: session.id,
      task: session.task,
      branchName: session.branchName,
      worktreePath: session.worktreePath,
      created: session.created,
      status: 'active',
      agentPid: process.pid,
    };
    await fs.writeFile(lockPath, JSON.stringify(lockData, null, 2));
  }

  private async removeSessionFiles(session: Session): Promise<void> {
    const sessionPath = path.join(SESSION_DIR, `${session.id}.json`);
    const lockPath = path.join(LOCK_DIR, `${session.id}.lock`);

    try {
      if (existsSync(sessionPath)) await fs.unlink(sessionPath);
      if (existsSync(lockPath)) await fs.unlink(lockPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
