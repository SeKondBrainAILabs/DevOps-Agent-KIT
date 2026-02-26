/**
 * DatabaseService
 * SQLite-based local database for persistent storage of:
 * - Activity logs (with commit hash linking)
 * - Settings
 * - Session history
 * - Terminal logs
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { BaseService } from './BaseService';
import type { ActivityLogEntry, LogType, TerminalLogEntry, TerminalLogLevel, IpcResult } from '../../shared/types';

// Database file location
const getDbPath = (): string => {
  const userDataPath = app.getPath('userData');
  const dbDir = join(userDataPath, 'data');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  return join(dbDir, 'kanvas.db');
};

export class DatabaseService extends BaseService {
  private db: Database.Database | null = null;

  /**
   * Initialize the database connection and create tables
   */
  async initialize(): Promise<void> {
    try {
      const dbPath = getDbPath();
      console.log(`[DatabaseService] Opening database at: ${dbPath}`);

      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL'); // Better performance

      this.createTables();
      this.runMigrations();
      console.log('[DatabaseService] Database initialized successfully');
    } catch (error) {
      console.error('[DatabaseService] Failed to initialize database:', error);
      throw error;
    }
  }

  /**
   * Create database tables if they don't exist
   */
  private createTables(): void {
    if (!this.db) return;

    // Activity logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        commit_hash TEXT,
        file_path TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_activity_commit ON activity_logs(commit_hash);
    `);

    // Terminal logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS terminal_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        session_id TEXT,
        source TEXT,
        command TEXT,
        output TEXT,
        exit_code INTEGER,
        duration INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_terminal_session ON terminal_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_terminal_timestamp ON terminal_logs(timestamp);
    `);

    // Settings table (key-value store)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Session history table (for tracking session lifecycle)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_history (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        details TEXT,
        commit_hash TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_session_history ON session_history(session_id);
    `);

    // Commits table (for tracking commits per session)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commits (
        hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        files_changed INTEGER DEFAULT 0,
        additions INTEGER DEFAULT 0,
        deletions INTEGER DEFAULT 0,
        author TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_commits_session ON commits(session_id);
      CREATE INDEX IF NOT EXISTS idx_commits_timestamp ON commits(timestamp);
    `);

    // Contracts table (for versioned contract storage)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contracts (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        contract_type TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        content TEXT NOT NULL,
        json_content TEXT,
        file_path TEXT,
        feature_name TEXT,
        is_repo_level INTEGER DEFAULT 0,
        generated_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_contracts_repo ON contracts(repo_path);
      CREATE INDEX IF NOT EXISTS idx_contracts_type ON contracts(contract_type);
      CREATE INDEX IF NOT EXISTS idx_contracts_feature ON contracts(feature_name);
      CREATE INDEX IF NOT EXISTS idx_contracts_version ON contracts(version);
    `);

    // Contract versions table (for tracking version history)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contract_versions (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        version TEXT NOT NULL,
        content TEXT NOT NULL,
        json_content TEXT,
        generated_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contract_id) REFERENCES contracts(id)
      );

      CREATE INDEX IF NOT EXISTS idx_contract_versions_contract ON contract_versions(contract_id);
    `);

    console.log('[DatabaseService] Tables created/verified');
  }

  /**
   * Run schema migrations (safe to call repeatedly — uses ALTER TABLE ADD COLUMN).
   * SQLite will error if column already exists, so we catch and ignore.
   */
  private runMigrations(): void {
    if (!this.db) return;

    const migrations: Array<{ description: string; sql: string }> = [
      {
        description: 'Add repo_name to commits',
        sql: 'ALTER TABLE commits ADD COLUMN repo_name TEXT',
      },
      {
        description: 'Add repo_name to activity_logs',
        sql: 'ALTER TABLE activity_logs ADD COLUMN repo_name TEXT',
      },
    ];

    for (const migration of migrations) {
      try {
        this.db.exec(migration.sql);
        console.log(`[DatabaseService] Migration applied: ${migration.description}`);
      } catch {
        // Column already exists — expected on subsequent startups
      }
    }
  }

  // ==========================================================================
  // ACTIVITY LOGS
  // ==========================================================================

  /**
   * Insert an activity log entry
   */
  insertActivityLog(entry: ActivityLogEntry): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT INTO activity_logs (id, session_id, timestamp, type, message, details, commit_hash, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.sessionId,
      entry.timestamp,
      entry.type,
      entry.message,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.commitHash || null,
      entry.filePath || null
    );
  }

  /**
   * Get activity logs for a session
   */
  getActivityLogs(sessionId: string, limit = 500, offset = 0): ActivityLogEntry[] {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT * FROM activity_logs
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(sessionId, limit, offset) as any[];
    return rows.map(this.rowToActivityLog);
  }

  /**
   * Get all activity logs (across all sessions)
   */
  getAllActivityLogs(limit = 1000): ActivityLogEntry[] {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT * FROM activity_logs
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];
    return rows.map(this.rowToActivityLog);
  }

  /**
   * Get uncommitted activity logs (logs without a commit hash)
   */
  getUncommittedActivityLogs(sessionId: string): ActivityLogEntry[] {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT * FROM activity_logs
      WHERE session_id = ? AND commit_hash IS NULL
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(sessionId) as any[];
    return rows.map(this.rowToActivityLog);
  }

  /**
   * Link activity logs to a commit (called when commit completes)
   */
  linkActivitiesToCommit(sessionId: string, commitHash: string, filePaths?: string[]): number {
    if (!this.db) return 0;

    let stmt;
    let result;

    if (filePaths && filePaths.length > 0) {
      // Link activities that match specific file paths
      const placeholders = filePaths.map(() => '?').join(',');
      stmt = this.db.prepare(`
        UPDATE activity_logs
        SET commit_hash = ?
        WHERE session_id = ?
          AND commit_hash IS NULL
          AND (file_path IN (${placeholders}) OR file_path IS NULL)
      `);
      result = stmt.run(commitHash, sessionId, ...filePaths);
    } else {
      // Link all uncommitted activities for this session
      stmt = this.db.prepare(`
        UPDATE activity_logs
        SET commit_hash = ?
        WHERE session_id = ? AND commit_hash IS NULL
      `);
      result = stmt.run(commitHash, sessionId);
    }

    console.log(`[DatabaseService] Linked ${result.changes} activities to commit ${commitHash.substring(0, 7)}`);
    return result.changes;
  }

  /**
   * Get activities linked to a specific commit
   */
  getActivitiesForCommit(commitHash: string): ActivityLogEntry[] {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT * FROM activity_logs
      WHERE commit_hash = ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(commitHash) as any[];
    return rows.map(this.rowToActivityLog);
  }

  /**
   * Clear activity logs for a session
   */
  clearActivityLogs(sessionId: string): void {
    if (!this.db) return;

    const stmt = this.db.prepare('DELETE FROM activity_logs WHERE session_id = ?');
    stmt.run(sessionId);
  }

  /**
   * Convert database row to ActivityLogEntry
   */
  private rowToActivityLog(row: any): ActivityLogEntry {
    return {
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      type: row.type as LogType,
      message: row.message,
      details: row.details ? JSON.parse(row.details) : undefined,
      commitHash: row.commit_hash || undefined,
      filePath: row.file_path || undefined,
    };
  }

  // ==========================================================================
  // TERMINAL LOGS
  // ==========================================================================

  /**
   * Insert a terminal log entry
   */
  insertTerminalLog(entry: TerminalLogEntry): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT INTO terminal_logs (id, timestamp, level, message, session_id, source, command, output, exit_code, duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.timestamp,
      entry.level,
      entry.message,
      entry.sessionId || null,
      entry.source || null,
      entry.command || null,
      entry.output || null,
      entry.exitCode ?? null,
      entry.duration ?? null
    );
  }

  /**
   * Get terminal logs
   */
  getTerminalLogs(limit = 500, sessionId?: string): TerminalLogEntry[] {
    if (!this.db) return [];

    let stmt;
    let rows;

    if (sessionId) {
      stmt = this.db.prepare(`
        SELECT * FROM terminal_logs
        WHERE session_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      rows = stmt.all(sessionId, limit) as any[];
    } else {
      stmt = this.db.prepare(`
        SELECT * FROM terminal_logs
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      rows = stmt.all(limit) as any[];
    }

    return rows.map(this.rowToTerminalLog);
  }

  /**
   * Clear terminal logs
   */
  clearTerminalLogs(sessionId?: string): void {
    if (!this.db) return;

    if (sessionId) {
      const stmt = this.db.prepare('DELETE FROM terminal_logs WHERE session_id = ?');
      stmt.run(sessionId);
    } else {
      this.db.exec('DELETE FROM terminal_logs');
    }
  }

  /**
   * Convert database row to TerminalLogEntry
   */
  private rowToTerminalLog(row: any): TerminalLogEntry {
    return {
      id: row.id,
      timestamp: row.timestamp,
      level: row.level as TerminalLogLevel,
      message: row.message,
      sessionId: row.session_id || undefined,
      source: row.source || undefined,
      command: row.command || undefined,
      output: row.output || undefined,
      exitCode: row.exit_code ?? undefined,
      duration: row.duration ?? undefined,
    };
  }

  // ==========================================================================
  // SETTINGS
  // ==========================================================================

  /**
   * Get a setting value
   */
  getSetting<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.db) return defaultValue;

    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;

    if (!row) return defaultValue;

    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as unknown as T;
    }
  }

  /**
   * Set a setting value
   */
  setSetting<T>(key: string, value: T): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(key, JSON.stringify(value));
  }

  /**
   * Delete a setting
   */
  deleteSetting(key: string): void {
    if (!this.db) return;

    const stmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    stmt.run(key);
  }

  /**
   * Get all settings
   */
  getAllSettings(): Record<string, unknown> {
    if (!this.db) return {};

    const stmt = this.db.prepare('SELECT key, value FROM settings');
    const rows = stmt.all() as { key: string; value: string }[];

    const settings: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    }
    return settings;
  }

  // ==========================================================================
  // COMMITS
  // ==========================================================================

  /**
   * Record a commit
   */
  recordCommit(
    hash: string,
    sessionId: string,
    message: string,
    timestamp: string,
    stats?: { filesChanged?: number; additions?: number; deletions?: number; author?: string; repoName?: string }
  ): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO commits (hash, session_id, message, timestamp, files_changed, additions, deletions, author, repo_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      hash,
      sessionId,
      message,
      timestamp,
      stats?.filesChanged ?? 0,
      stats?.additions ?? 0,
      stats?.deletions ?? 0,
      stats?.author || null,
      stats?.repoName || null
    );
  }

  /**
   * Get commits for a session
   */
  getCommitsForSession(sessionId: string, limit = 100, repoName?: string): Array<{
    hash: string;
    message: string;
    timestamp: string;
    filesChanged: number;
    additions: number;
    deletions: number;
    repoName?: string;
  }> {
    if (!this.db) return [];

    let sql = 'SELECT * FROM commits WHERE session_id = ?';
    const params: any[] = [sessionId];

    if (repoName) {
      sql += ' AND repo_name = ?';
      params.push(repoName);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({
      hash: row.hash,
      message: row.message,
      timestamp: row.timestamp,
      filesChanged: row.files_changed,
      additions: row.additions,
      deletions: row.deletions,
      repoName: row.repo_name || undefined,
    }));
  }

  /**
   * Get commit count for a session
   */
  getCommitCount(sessionId: string): number {
    if (!this.db) return 0;

    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM commits WHERE session_id = ?');
    const row = stmt.get(sessionId) as { count: number };
    return row?.count || 0;
  }

  // ==========================================================================
  // SESSION HISTORY
  // ==========================================================================

  /**
   * Record a session event
   */
  recordSessionEvent(
    sessionId: string,
    eventType: 'created' | 'started' | 'paused' | 'resumed' | 'closed' | 'restarted' | 'commit',
    details?: Record<string, unknown>,
    commitHash?: string
  ): void {
    if (!this.db) return;

    const id = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const stmt = this.db.prepare(`
      INSERT INTO session_history (id, session_id, event_type, timestamp, details, commit_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      sessionId,
      eventType,
      new Date().toISOString(),
      details ? JSON.stringify(details) : null,
      commitHash || null
    );
  }

  /**
   * Get session history
   */
  getSessionHistory(sessionId: string): Array<{
    eventType: string;
    timestamp: string;
    details?: Record<string, unknown>;
    commitHash?: string;
  }> {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT event_type, timestamp, details, commit_hash
      FROM session_history
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(sessionId) as any[];
    return rows.map(row => ({
      eventType: row.event_type,
      timestamp: row.timestamp,
      details: row.details ? JSON.parse(row.details) : undefined,
      commitHash: row.commit_hash || undefined,
    }));
  }

  // ==========================================================================
  // CONTRACTS
  // ==========================================================================

  /**
   * Save a contract to the database
   */
  saveContract(params: {
    repoPath: string;
    contractType: string;
    name: string;
    version: string;
    content: string;
    jsonContent?: string;
    filePath?: string;
    featureName?: string;
    isRepoLevel?: boolean;
  }): string {
    if (!this.db) return '';

    const id = `contract_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const generatedAt = new Date().toISOString();

    // Check if contract already exists (by repo, type, and feature/name)
    const existingStmt = this.db.prepare(`
      SELECT id, version FROM contracts
      WHERE repo_path = ? AND contract_type = ? AND name = ?
        AND (feature_name = ? OR (feature_name IS NULL AND ? IS NULL))
    `);
    const existing = existingStmt.get(
      params.repoPath,
      params.contractType,
      params.name,
      params.featureName || null,
      params.featureName || null
    ) as { id: string; version: string } | undefined;

    if (existing) {
      // Save current version to history before updating
      const historyId = `cv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const historyStmt = this.db.prepare(`
        INSERT INTO contract_versions (id, contract_id, version, content, json_content, generated_at)
        SELECT ?, id, version, content, json_content, generated_at
        FROM contracts WHERE id = ?
      `);
      historyStmt.run(historyId, existing.id);

      // Update existing contract
      const updateStmt = this.db.prepare(`
        UPDATE contracts SET
          version = ?,
          content = ?,
          json_content = ?,
          file_path = ?,
          generated_at = ?
        WHERE id = ?
      `);
      updateStmt.run(
        params.version,
        params.content,
        params.jsonContent || null,
        params.filePath || null,
        generatedAt,
        existing.id
      );

      console.log(`[DatabaseService] Updated contract ${params.name} v${params.version}`);
      return existing.id;
    }

    // Insert new contract
    const insertStmt = this.db.prepare(`
      INSERT INTO contracts (id, repo_path, contract_type, name, version, content, json_content, file_path, feature_name, is_repo_level, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      id,
      params.repoPath,
      params.contractType,
      params.name,
      params.version,
      params.content,
      params.jsonContent || null,
      params.filePath || null,
      params.featureName || null,
      params.isRepoLevel ? 1 : 0,
      generatedAt
    );

    console.log(`[DatabaseService] Saved new contract ${params.name} v${params.version}`);
    return id;
  }

  /**
   * Get contracts for a repository
   */
  getContractsForRepo(repoPath: string): Array<{
    id: string;
    contractType: string;
    name: string;
    version: string;
    filePath?: string;
    featureName?: string;
    isRepoLevel: boolean;
    generatedAt: string;
  }> {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT id, contract_type, name, version, file_path, feature_name, is_repo_level, generated_at
      FROM contracts
      WHERE repo_path = ?
      ORDER BY is_repo_level DESC, name ASC
    `);

    const rows = stmt.all(repoPath) as any[];
    return rows.map(row => ({
      id: row.id,
      contractType: row.contract_type,
      name: row.name,
      version: row.version,
      filePath: row.file_path || undefined,
      featureName: row.feature_name || undefined,
      isRepoLevel: row.is_repo_level === 1,
      generatedAt: row.generated_at,
    }));
  }

  /**
   * Get a specific contract with full content
   */
  getContract(contractId: string): {
    id: string;
    repoPath: string;
    contractType: string;
    name: string;
    version: string;
    content: string;
    jsonContent?: string;
    filePath?: string;
    featureName?: string;
    isRepoLevel: boolean;
    generatedAt: string;
  } | null {
    if (!this.db) return null;

    const stmt = this.db.prepare('SELECT * FROM contracts WHERE id = ?');
    const row = stmt.get(contractId) as any;

    if (!row) return null;

    return {
      id: row.id,
      repoPath: row.repo_path,
      contractType: row.contract_type,
      name: row.name,
      version: row.version,
      content: row.content,
      jsonContent: row.json_content || undefined,
      filePath: row.file_path || undefined,
      featureName: row.feature_name || undefined,
      isRepoLevel: row.is_repo_level === 1,
      generatedAt: row.generated_at,
    };
  }

  /**
   * Get contract version history
   */
  getContractVersionHistory(contractId: string): Array<{
    id: string;
    version: string;
    generatedAt: string;
  }> {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT id, version, generated_at
      FROM contract_versions
      WHERE contract_id = ?
      ORDER BY generated_at DESC
    `);

    const rows = stmt.all(contractId) as any[];
    return rows.map(row => ({
      id: row.id,
      version: row.version,
      generatedAt: row.generated_at,
    }));
  }

  /**
   * Get a specific version's content
   */
  getContractVersion(versionId: string): {
    version: string;
    content: string;
    jsonContent?: string;
    generatedAt: string;
  } | null {
    if (!this.db) return null;

    const stmt = this.db.prepare('SELECT version, content, json_content, generated_at FROM contract_versions WHERE id = ?');
    const row = stmt.get(versionId) as any;

    if (!row) return null;

    return {
      version: row.version,
      content: row.content,
      jsonContent: row.json_content || undefined,
      generatedAt: row.generated_at,
    };
  }

  /**
   * Get the latest version of a contract by type and name
   */
  getLatestContractVersion(repoPath: string, contractType: string, name: string): string | null {
    if (!this.db) return null;

    const stmt = this.db.prepare(`
      SELECT version FROM contracts
      WHERE repo_path = ? AND contract_type = ? AND name = ?
      LIMIT 1
    `);
    const row = stmt.get(repoPath, contractType, name) as { version: string } | undefined;

    return row?.version || null;
  }

  // ==========================================================================
  // CLEANUP & LIFECYCLE
  // ==========================================================================

  /**
   * Clean up old data (older than specified days)
   */
  cleanupOldData(daysToKeep = 30): { activitiesDeleted: number; terminalLogsDeleted: number } {
    if (!this.db) return { activitiesDeleted: 0, terminalLogsDeleted: 0 };

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffStr = cutoffDate.toISOString();

    const activityResult = this.db.prepare(
      'DELETE FROM activity_logs WHERE timestamp < ?'
    ).run(cutoffStr);

    const terminalResult = this.db.prepare(
      'DELETE FROM terminal_logs WHERE timestamp < ?'
    ).run(cutoffStr);

    console.log(`[DatabaseService] Cleaned up ${activityResult.changes} activities and ${terminalResult.changes} terminal logs older than ${daysToKeep} days`);

    return {
      activitiesDeleted: activityResult.changes,
      terminalLogsDeleted: terminalResult.changes,
    };
  }

  /**
   * Get database statistics
   */
  getStats(): {
    activityCount: number;
    terminalLogCount: number;
    commitCount: number;
    sessionCount: number;
  } {
    if (!this.db) return { activityCount: 0, terminalLogCount: 0, commitCount: 0, sessionCount: 0 };

    const activityCount = (this.db.prepare('SELECT COUNT(*) as count FROM activity_logs').get() as any).count;
    const terminalLogCount = (this.db.prepare('SELECT COUNT(*) as count FROM terminal_logs').get() as any).count;
    const commitCount = (this.db.prepare('SELECT COUNT(*) as count FROM commits').get() as any).count;
    const sessionCount = (this.db.prepare('SELECT COUNT(DISTINCT session_id) as count FROM activity_logs').get() as any).count;

    return { activityCount, terminalLogCount, commitCount, sessionCount };
  }

  /**
   * Transfer all session data from one sessionId to another
   * Used during session restart to preserve commit history and activity logs
   */
  transferSessionData(oldSessionId: string, newSessionId: string): { transferred: { commits: number; activity: number; terminal: number; history: number } } {
    const result = { commits: 0, activity: 0, terminal: 0, history: 0 };
    if (!this.db) return { transferred: result };

    try {
      // Transfer commits
      const commitStmt = this.db.prepare('UPDATE commits SET session_id = ? WHERE session_id = ?');
      const commitResult = commitStmt.run(newSessionId, oldSessionId);
      result.commits = commitResult.changes;

      // Transfer activity logs
      const activityStmt = this.db.prepare('UPDATE activity_logs SET session_id = ? WHERE session_id = ?');
      const activityResult = activityStmt.run(newSessionId, oldSessionId);
      result.activity = activityResult.changes;

      // Transfer terminal logs
      const terminalStmt = this.db.prepare('UPDATE terminal_logs SET session_id = ? WHERE session_id = ?');
      const terminalResult = terminalStmt.run(newSessionId, oldSessionId);
      result.terminal = terminalResult.changes;

      // Transfer session history
      const historyStmt = this.db.prepare('UPDATE session_history SET session_id = ? WHERE session_id = ?');
      const historyResult = historyStmt.run(newSessionId, oldSessionId);
      result.history = historyResult.changes;

      console.log(`[DatabaseService] Transferred session data from ${oldSessionId} to ${newSessionId}: ${JSON.stringify(result)}`);
      return { transferred: result };
    } catch (error) {
      console.error(`[DatabaseService] Failed to transfer session data:`, error);
      return { transferred: result };
    }
  }

  /**
   * Close the database connection
   */
  async dispose(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[DatabaseService] Database closed');
    }
  }
}

export const databaseService = new DatabaseService();
