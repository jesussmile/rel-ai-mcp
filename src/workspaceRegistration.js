import * as fs from 'node:fs';
import * as path from 'node:path';

import { getConfigPath, makeDefaultConfig, readConfig } from './config.js';
import { withConfigEditLock } from './configEditLock.js';
import { updateWorkspace, validateAlias, workspaceAliasForPath } from './configEditor.js';
import { workspaceMutationSafetySummary } from './mutationProcessOwnership.js';
import { canonicalWorkspaceAuthority } from './workspaceOperationQueue.js';
import { assertSafeWorkspaceRoot } from './workspaceSafety.js';

const RESTART_NOTE = 'Rel.AI reads config changes live; no restart is needed. Restarting while a task runs a command kills that command and leaves its project folder blocked.';

// Read-only facts about a folder before it becomes a workspace: which
// configured workspaces share its change lock, and whether that lock is
// currently blocked by unconfirmed process termination.
function inspectWorkspaceFolder(config, alias, workspacePath) {
  const resolved = path.resolve(String(workspacePath || '').trim());
  const authority = canonicalWorkspaceAuthority(resolved);
  const sharedChangeLockWith = [];
  for (const [candidateAlias, candidate] of Object.entries(config?.workspaces || {})) {
    if (candidateAlias === alias || !candidate?.path) continue;
    try {
      if (canonicalWorkspaceAuthority(candidate.path) === authority) sharedChangeLockWith.push(candidateAlias);
    } catch { /* A missing or unreadable workspace cannot share a verified lock. */ }
  }
  const block = workspaceMutationSafetySummary(config, alias, resolved);
  return {
    path: resolved,
    changeLock: authority.startsWith('repo:') ? 'git repository' : 'folder',
    sharedChangeLockWith: sharedChangeLockWith.sort((left, right) => left.localeCompare(right)),
    changesBlocked: block ? { code: block.code, blockedAt: block.blockedAt, message: block.message } : null
  };
}

function assertWorkspaceDirectory(workspacePath) {
  const text = String(workspacePath || '').trim();
  if (!path.isAbsolute(text)) throw codedError('WORKSPACE_PATH_NOT_ABSOLUTE', 'Workspace path must be absolute.');
  let stat;
  try { stat = fs.statSync(text); } catch {
    throw codedError('WORKSPACE_PATH_MISSING', `Workspace folder does not exist: ${path.resolve(text)}`);
  }
  if (!stat.isDirectory()) throw codedError('WORKSPACE_PATH_NOT_DIRECTORY', `Workspace path is not a folder: ${path.resolve(text)}`);
}

function configSnapshot(configPath) {
  try {
    const stat = fs.statSync(configPath, { bigint: true });
    return { exists: true, mtimeNs: stat.mtimeNs, size: stat.size };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

// Refuses a write when another writer (for example the running dashboard)
// changed config.json after this caller read it.
function assertConfigUnchanged(before, configPath = getConfigPath()) {
  const after = configSnapshot(configPath);
  const same = before.exists === after.exists
    && (!before.exists || (before.mtimeNs === after.mtimeNs && before.size === after.size));
  if (!same) throw codedError('CONFIG_CHANGED_CONCURRENTLY', 'Rel.AI config changed while this workspace was being added. Nothing was written; retry.', { retryable: true });
}

// Adds (or with update=true, updates) a workspace through the same validated
// editor the dashboard uses, under the config edit lock, with an atomic write.
function registerWorkspace(alias, workspacePath, options = {}) {
  const configPath = getConfigPath();
  const name = String(alias || '').trim();
  return withConfigEditLock(() => {
    // The editor repeats these checks on write; running them first keeps --dry-run truthful.
    validateAlias(name);
    assertWorkspaceDirectory(workspacePath);
    assertSafeWorkspaceRoot(workspacePath);
    const before = configSnapshot(configPath);
    const current = before.exists ? readConfig() : makeDefaultConfig();
    const exists = Boolean(current.workspaces?.[name]);
    if (exists && options.update !== true) {
      throw codedError('WORKSPACE_EXISTS', `Workspace '${name}' already exists. Pass --update to change it.`);
    }
    if (!exists && options.update === true) {
      throw codedError('WORKSPACE_NOT_CONFIGURED', `Workspace '${name}' is not configured.`);
    }
    const duplicateAlias = workspaceAliasForPath(current.workspaces, workspacePath, name);
    if (duplicateAlias) throw codedError('WORKSPACE_PATH_DUPLICATE', `Project folder is already configured as workspace '${duplicateAlias}'.`);
    const folder = inspectWorkspaceFolder(current, name, workspacePath);
    const result = {
      ok: true,
      dryRun: options.dryRun === true,
      action: exists ? 'update' : 'create',
      alias: name,
      ...folder,
      configPath,
      restartRequired: false,
      notes: [RESTART_NOTE]
    };
    if (folder.sharedChangeLockWith.length) {
      result.notes.push(`This folder shares its change lock with ${folder.sharedChangeLockWith.join(', ')}. A command interrupted in any of them blocks changes in all of them.`);
    }
    if (folder.changesBlocked && options.allowBlocked !== true) {
      return {
        ...result,
        ok: false,
        code: 'WORKSPACE_CHANGES_BLOCKED',
        error: `Not added: this folder's change lock is blocked (${folder.changesBlocked.code}). ${folder.changesBlocked.message} Resolve that first, or pass --allow-blocked to add it anyway.`
      };
    }
    if (folder.changesBlocked) result.notes.push('Added while the change lock is blocked; it will show "Changes blocked" until recovery.');
    if (options.dryRun === true) return result;
    assertConfigUnchanged(before, configPath);
    updateWorkspace(current, {
      action: 'upsert',
      alias: name,
      workspaceConfig: { mode: exists ? 'update' : 'create', path: workspacePath, sourcePaths: [workspacePath] }
    });
    return result;
  }, configPath);
}

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export { assertConfigUnchanged, inspectWorkspaceFolder, registerWorkspace };
