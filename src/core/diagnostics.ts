import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { clearAuditHistory, readAudit } from '../audit.js';
import { getConfigPath, invalidateConfigCache, readConfig } from '../config.js';
import * as connection from '../connectionProfile.js';
import { deriveConnectionState } from '../contracts/connection.ts';
import type { DiagnosticResetTarget } from '../contracts/diagnostics.ts';
import { ERROR_CODES } from '../contracts/errors.ts';
import { buildDiagnosticReport } from '../diagnostics.js';
import { hostResourceDiagnosticSnapshot, refreshHostResourceDiagnostics } from '../hostResourceScheduler.js';
import { resourceDiagnosticsSnapshot } from '../resourceDiagnostics.js';
import { cacheStats } from '../sessionCache.js';
import { sampleManagedProcessMemory } from '../processManager.js';
import { clearLocalAnalytics } from '../localAnalytics.js';
import * as productUx from '../productUx.js';
import { withStateDatabase } from '../stateDatabase.ts';
import { TASK_HISTORY_PROJECTION_SCHEMA_SQL } from '../taskHistoryProjectionSchema.ts';
import { taskHistoryPersistenceSnapshot } from '../taskHistoryStore.ts';
import { activeLogicalTaskCount, isTerminalTaskStatus } from '../taskState.js';
import { clearTopologyCache } from '../workflow/topology.js';

export interface DiagnosticsRuntimeOptions {
  host?: string;
  port?: number;
  token?: string;
  getDesktopStatus?: () => Record<string, unknown>;
  getTaskActivity?: () => Record<string, unknown>;
  getRuntimeLogs?: (options?: { limit?: number }) => Record<string, unknown>;
  resetTaskActivity?: () => Record<string, unknown>;
  clearRuntimeLogs?: () => Promise<unknown> | unknown;
}

interface DiagnosticResetFailure {
  ok: false;
  category: 'conflict';
  errorCode: string;
  error: string;
}

interface DiagnosticRepairSummary {
  repairedTasks: number;
  compactedSummaries: number;
  prunedWorkspaces: number;
  cleanedEntries: number;
}

interface DiagnosticResetSuccess {
  ok: true;
  target: DiagnosticResetTarget;
  history: unknown | null;
  runtimeLogs: unknown | null;
  analytics: unknown | null;
  repair?: DiagnosticRepairSummary | null;
  message: string;
}

export type DiagnosticResetOutcome = DiagnosticResetFailure | DiagnosticResetSuccess;

export async function getDiagnosticsReport(
  options: DiagnosticsRuntimeOptions,
  workspace = '',
  { includeManagedProcessMemory = false, refreshResources = false }: { includeManagedProcessMemory?: boolean; refreshResources?: boolean } = {}
): Promise<Record<string, unknown>> {
  const config = readConfig();
  const hostResources = refreshResources ? await refreshHostResourceDiagnostics() : hostResourceDiagnosticSnapshot();
  // Only the authenticated local dashboard route opts into owned-root details.
  // This report is not an automatic telemetry or public MCP response.
  let managedRoots = null;
  if (includeManagedProcessMemory) {
    try {
      managedRoots = await sampleManagedProcessMemory(config, { workspace, limit: 20 }, { internal: true });
    } catch {
      managedRoots = {
        scope: 'managed_roots_only', roots: [], sampledAt: null, cacheAgeMs: null,
        totalRootCount: null, omittedRootCount: null, stale: true,
        descendantAttribution: 'unknown', reason: 'Managed-root memory is unavailable for this authorized scope.'
      };
    }
  }
  const profile = connection.readConnectionProfile();
  const connectionSummary = connection.buildConnectionSummary({
    host: profile.host || options.host || '127.0.0.1',
    port: profile.port || options.port || 3333,
    token: options.token,
    tunnelId: profile.tunnelId || '',
    tunnelProvider: 'openai-secure-mcp',
    showToken: false,
    includeTokenInUrls: false
  });
  const desktopStatus = typeof options.getDesktopStatus === 'function' ? options.getDesktopStatus() : null;
  const desktopBuildStatus = desktopStatus?.buildStatus;
  const buildId = desktopBuildStatus && typeof desktopBuildStatus === 'object' && !Array.isArray(desktopBuildStatus)
    ? String((desktopBuildStatus as Record<string, unknown>).buildId || '').trim()
    : '';
  const connectionState = desktopStatus?.connectionState || deriveConnectionState(desktopStatus || {
    serverRunning: false,
    tunnelStatus: 'stopped'
  });
  const activity = typeof options.getTaskActivity === 'function' ? options.getTaskActivity() : {};
  const runtimeLogs = typeof options.getRuntimeLogs === 'function'
    ? options.getRuntimeLogs({ limit: 100 })
    : { available: false, count: 0, entries: [] };
  const auditLogs = readAudit(config, { limit: 200, ...(workspace ? { workspace } : {}) });
  return buildDiagnosticReport({
    workspace,
    application: { version: String(desktopStatus?.version || '').trim(), build: buildId },
    health: productUx.healthMonitor(config),
    cautionData: productUx.cautionSummary(config, { windowHours: 24, limit: 500 }),
    connection: connectionSummary,
    connectionState,
    tunnelHealth: desktopStatus?.tunnelHealth || null,
    resourceDiagnostics: resourceDiagnosticsSnapshot(hostResources, cacheStats(), managedRoots),
    runtimeLogs,
    auditLogs,
    taskHistoryPersistence: taskHistoryPersistenceSnapshot(),
    activeTaskCount: activeLogicalTaskCount(activity)
  });
}

export async function resetDiagnostics(
  target: DiagnosticResetTarget,
  options: DiagnosticsRuntimeOptions = {}
): Promise<DiagnosticResetOutcome> {
  if (target === 'repair') {
    return repairRuntimeState(options);
  }
  const activity = typeof options.getTaskActivity === 'function' ? options.getTaskActivity() : {};
  const activeTasks = activeLogicalTaskCount(activity);
  if ((target === 'history' || target === 'analytics') && activeTasks > 0) {
    const noun = activeTasks === 1 ? 'task is' : 'tasks are';
    const data = target === 'analytics' ? 'analytics' : 'session and activity history';
    return failure(`Cannot clear ${data} while ${activeTasks} Rel.AI ${noun} still active.`);
  }
  if (target === 'runtime_logs' && typeof options.clearRuntimeLogs !== 'function') {
    return failure('Service logs can be cleared only in the Rel.AI desktop app.');
  }

  const result: DiagnosticResetSuccess = { ok: true, target, history: null, runtimeLogs: null, analytics: null, message: resetMessage(target) };
  if (target === 'history') {
    const history = await clearHistory(options);
    if (!history.ok) return history;
    result.history = history.value;
  }
  if (target === 'runtime_logs') result.runtimeLogs = await options.clearRuntimeLogs!();
  if (target === 'analytics') result.analytics = await clearLocalAnalytics(readConfig());
  return result;
}

async function clearHistory(options: DiagnosticsRuntimeOptions): Promise<{ ok: true; value: { removedFiles: number; removedBytes: number } } | DiagnosticResetFailure> {
  if (typeof options.resetTaskActivity === 'function') {
    const reset = options.resetTaskActivity();
    if (reset?.ok === false) return failure(typeof reset.error === 'string' ? reset.error : 'Session history could not be cleared.');
  }
  const cleared = await clearAuditHistory(readConfig());
  return { ok: true, value: { removedFiles: cleared.removedFiles, removedBytes: cleared.removedBytes } };
}

async function repairRuntimeState(options: DiagnosticsRuntimeOptions): Promise<DiagnosticResetOutcome> {
  try {
    const config = readConfig();
    const activity = typeof options.getTaskActivity === 'function' ? options.getTaskActivity() : {};
    const activeCalls = Math.max(0, Number(activity.activeCalls || 0));
    const liveCallingIds = new Set<string>();
    const liveCallingWorkspaces = new Set<string>();
    const liveTasks = Array.isArray(activity.tasks) ? activity.tasks : [];
    for (const item of liveTasks) {
      if (!item || typeof item !== 'object') continue;
      const task = item as Record<string, unknown>;
      if (Number(task.activeCalls || 0) > 0) {
        const id = String(task.taskId || task.id || '').trim();
        const ws = String(task.workspace || '').trim();
        if (id) liveCallingIds.add(id);
        if (ws) liveCallingWorkspaces.add(ws);
      }
    }

    if (activeCalls === 0 && typeof options.resetTaskActivity === 'function') {
      try { options.resetTaskActivity(); } catch {}
    }

    let repairedTasks = 0;
    let compactedSummaries = 0;
    const recentEuropeWorkspaces: string[] = [];

    withStateDatabase(config, (db: DatabaseSync) => {
      db.exec(TASK_HISTORY_PROJECTION_SCHEMA_SQL);
      const rows = db.prepare(`
        SELECT id, updated_at_ms, payload
        FROM task_history
        WHERE json_valid(payload)
          AND COALESCE(json_extract(payload, '$.status'), '') NOT IN ('completed', 'failed', 'cancelled', 'inactive')
      `).all() as Array<{ id: string; updated_at_ms: number; payload: string }>;

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const updateStmt = db.prepare('UPDATE task_history SET updated_at_ms = ?, payload = ? WHERE id = ?');

      for (const row of rows) {
        const id = String(row.id || '').trim();
        if (!id || liveCallingIds.has(id)) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        const status = String(parsed.status || '').trim();
        if (status === 'inactive' || isTerminalTaskStatus(status)) continue;
        const reconciled: Record<string, unknown> = {
          ...parsed,
          state: 'inactive',
          status: 'inactive',
          resumeStatus: parsed.resumeStatus || status || 'planning',
          currentStage: 'Inactive',
          completionKnown: false,
          activeCalls: 0,
          currentOperations: [],
          inactiveAt: nowIso,
          updatedAt: nowIso
        };
        updateStmt.run(Math.max(Number(row.updated_at_ms || 0), nowMs), JSON.stringify(reconciled), id);
        repairedTasks += 1;
      }

      const compactResult = db.prepare(`
        UPDATE task_history_summaries
        SET payload = json_remove(
          payload,
          '$.events',
          '$.workflowEvidence',
          '$.backgroundOperations',
          '$.backgroundOperation',
          '$.eventCounterReceipts'
        )
        WHERE json_valid(payload)
          AND (
            json_type(payload, '$.backgroundOperations') IS NOT NULL
            OR json_type(payload, '$.backgroundOperation') IS NOT NULL
            OR json_type(payload, '$.eventCounterReceipts') IS NOT NULL
          )
      `).run() as { changes?: number };
      compactedSummaries = Math.max(0, Number(compactResult?.changes || 0));

      const europeRows = db.prepare(`
        SELECT workspace, MAX(updated_at_ms) AS latest_ms
        FROM task_history_summaries
        WHERE workspace LIKE 'europe_%'
        GROUP BY workspace
        ORDER BY latest_ms DESC
        LIMIT 3
      `).all() as Array<{ workspace?: string }>;
      for (const item of europeRows) {
        const ws = String(item.workspace || '').trim();
        if (ws) recentEuropeWorkspaces.push(ws);
      }
    }, { transaction: true });

    withStateDatabase(config, (db: DatabaseSync) => {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    });

    const prunedWorkspaces = pruneStaleBatchWorkspaces(recentEuropeWorkspaces, liveCallingWorkspaces);
    const cleanedEntries = await cleanStaleStateDirectories(String(config.stateDir || ''), activeCalls === 0);

    clearTopologyCache();
    invalidateConfigCache();

    const parts: string[] = [];
    if (repairedTasks > 0) parts.push(`${repairedTasks} stuck ${repairedTasks === 1 ? 'task' : 'tasks'} reconciled`);
    if (prunedWorkspaces > 0) parts.push(`${prunedWorkspaces} stale job ${prunedWorkspaces === 1 ? 'workspace' : 'workspaces'} pruned`);
    if (compactedSummaries > 0) parts.push(`${compactedSummaries} task ${compactedSummaries === 1 ? 'summary' : 'summaries'} compacted`);
    if (cleanedEntries > 0) parts.push(`${cleanedEntries} temporary state ${cleanedEntries === 1 ? 'entry' : 'entries'} cleaned`);

    const message = parts.length > 0
      ? `Connection and state repaired (${parts.join(', ')}).`
      : 'Connection and runtime state verified; workspace and discovery caches refreshed.';

    return {
      ok: true,
      target: 'repair',
      history: null,
      runtimeLogs: null,
      analytics: null,
      repair: {
        repairedTasks,
        compactedSummaries,
        prunedWorkspaces,
        cleanedEntries
      },
      message
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Runtime state repair could not be completed.');
  }
}

function pruneStaleBatchWorkspaces(recentEuropeWorkspaces: string[], liveCallingWorkspaces: Set<string>): number {
  try {
    const configPath = getConfigPath();
    if (!configPath || !fs.existsSync(configPath)) return 0;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const workspaces = raw.workspaces;
    if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) return 0;
    const workspaceMap = workspaces as Record<string, unknown>;
    const europeKeys = Object.keys(workspaceMap).filter(alias => /^europe_/i.test(alias));
    if (europeKeys.length <= 3) return 0;

    const keep = new Set<string>(liveCallingWorkspaces);
    for (const ws of recentEuropeWorkspaces) {
      if (ws in workspaceMap) keep.add(ws);
    }
    for (const ws of europeKeys.slice(-3)) {
      if (keep.size >= 3) break;
      keep.add(ws);
    }

    let pruned = 0;
    for (const alias of europeKeys) {
      if (keep.has(alias)) continue;
      delete workspaceMap[alias];
      pruned += 1;
    }
    if (pruned > 0) {
      fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    }
    return pruned;
  } catch {
    return 0;
  }
}

async function cleanStaleStateDirectories(stateDir: string, idle: boolean): Promise<number> {
  if (!stateDir) return 0;
  let cleaned = 0;
  const resolvedState = path.resolve(stateDir);
  const fallbackDir = path.join(resolvedState, 'fallback-executions');
  const cutoffMs = Date.now() - (idle ? 5 * 60_000 : 60 * 60_000);
  try {
    const entries = await fs.promises.readdir(fallbackDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = path.join(fallbackDir, entry.name);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat.mtimeMs <= cutoffMs) {
          await fs.promises.rm(fullPath, { force: true });
          cleaned += 1;
        }
      } catch {}
    }
  } catch {}

  for (const dirName of ['active-mutations-v3', 'write-staging']) {
    const parentDir = path.join(resolvedState, dirName);
    try {
      const entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childPath = path.join(parentDir, entry.name);
        try {
          const children = await fs.promises.readdir(childPath);
          if (children.length === 0) {
            await fs.promises.rmdir(childPath);
            cleaned += 1;
          }
        } catch {}
      }
    } catch {}
  }
  return cleaned;
}

function failure(error: string): DiagnosticResetFailure {
  return { ok: false, category: 'conflict', errorCode: ERROR_CODES.STATE_RESET_FAILED, error };
}

function resetMessage(target: DiagnosticResetTarget): string {
  if (target === 'history') return 'Session and activity history cleared.';
  if (target === 'runtime_logs') return 'Persistent service log cleared.';
  if (target === 'repair') return 'Connection and runtime state repaired.';
  return 'Local analytics cleared.';
}
