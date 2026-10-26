import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relai-workspace-registration-')));
const stateDir = path.join(tmp, 'state');
const configPath = path.join(stateDir, 'config.json');
const previous = { config: process.env.REL_AI_MCP_CONFIG, state: process.env.REL_AI_MCP_STATE_DIR };
process.env.REL_AI_MCP_CONFIG = configPath;
process.env.REL_AI_MCP_STATE_DIR = stateDir;

const { registerWorkspace, inspectWorkspaceFolder, assertConfigUnchanged } = await import('../src/workspaceRegistration.js');
const { updateWorkspace } = await import('../src/configEditor.js');
const { readConfig } = await import('../src/config.js');
const { canonicalWorkspaceAuthority } = await import('../src/workspaceOperationQueue.js');

const lockPath = `${configPath}.edit-lock`;
const saved = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
const code = expected => error => error?.code === expected;

try {
  const repo = path.join(tmp, 'repo');
  const nested = path.join(repo, 'nested');
  const other = path.join(tmp, 'other');
  const plain = path.join(tmp, 'plain');
  for (const dir of [path.join(repo, '.git'), nested, other, plain]) fs.mkdirSync(dir, { recursive: true });

  // A first add creates config.json with a complete, normalized entry.
  const created = registerWorkspace('repo', repo);
  assert.equal(created.ok, true);
  assert.equal(created.action, 'create');
  assert.equal(created.restartRequired, false);
  assert.equal(created.changeLock, 'git repository');
  assert.deepEqual(created.sharedChangeLockWith, []);
  assert.equal(saved().workspaces.repo.path, repo);
  assert.deepEqual(saved().workspaces.repo.sourcePaths, [repo]);
  assert.ok(Array.isArray(saved().workspaces.repo.context.excludePaths));
  assert.equal(fs.existsSync(lockPath), false, 'the edit lock is released after a write');

  // A folder inside the same Git repository reports the shared change lock.
  const nestedResult = registerWorkspace('nested', nested);
  assert.equal(nestedResult.ok, true);
  assert.deepEqual(nestedResult.sharedChangeLockWith, ['repo']);
  assert.match(nestedResult.notes.join('\n'), /shares its change lock with repo/);
  assert.deepEqual(inspectWorkspaceFolder(readConfig(), '', nested).sharedChangeLockWith, ['nested', 'repo']);
  assert.equal(inspectWorkspaceFolder(readConfig(), '', plain).changeLock, 'folder');

  // Existing aliases are never silently overwritten; --update replaces stale source paths.
  assert.throws(() => registerWorkspace('repo', other), code('WORKSPACE_EXISTS'));
  assert.throws(() => registerWorkspace('missing', other, { update: true }), code('WORKSPACE_NOT_CONFIGURED'));
  updateWorkspace(readConfig(), { action: 'upsert', alias: 'nested', workspaceConfig: { mode: 'update', sourcePaths: [nested, plain] } });
  assert.deepEqual(saved().workspaces.nested.sourcePaths, [nested, plain]);
  const moved = registerWorkspace('nested', other, { update: true });
  assert.equal(moved.action, 'update');
  assert.equal(saved().workspaces.nested.path, other);
  assert.deepEqual(saved().workspaces.nested.sourcePaths, [other]);

  // Validation happens before any write.
  const before = fs.readFileSync(configPath, 'utf8');
  assert.throws(() => registerWorkspace('dup', other), /already configured as workspace 'nested'/);
  assert.throws(() => registerWorkspace('gone', path.join(tmp, 'does-not-exist')), code('WORKSPACE_PATH_MISSING'));
  assert.throws(() => registerWorkspace('relative', 'relative/folder'), code('WORKSPACE_PATH_NOT_ABSOLUTE'));
  fs.writeFileSync(path.join(tmp, 'file.txt'), 'x');
  assert.throws(() => registerWorkspace('file', path.join(tmp, 'file.txt')), code('WORKSPACE_PATH_NOT_DIRECTORY'));
  assert.throws(() => registerWorkspace('bad alias!', plain), /Workspace alias must be/);
  assert.throws(() => registerWorkspace('root', path.parse(tmp).root), /Unsafe workspace path refused/);
  const dryRun = registerWorkspace('plain', plain, { dryRun: true });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'failed or dry-run adds leave config.json untouched');

  // A blocked change lock (interrupted mutation in a sibling workspace) refuses the add by default.
  const authority = canonicalWorkspaceAuthority(repo);
  const recordDir = path.join(stateDir, 'active-mutations-v3', crypto.createHash('sha256').update(authority).digest('hex'));
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, 'runtime_1_previous-intent-abc.json'), JSON.stringify({
    schemaVersion: 3, runtimeId: 'runtime_1_previous', workspace: 'repo', authority, authorityStatus: 'bound',
    pid: 4242, phase: 'active', terminationUncertain: true, startedAt: '2026-10-26T22:35:40.699Z'
  }));
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub);
  const refused = registerWorkspace('sub', sub);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'WORKSPACE_CHANGES_BLOCKED');
  assert.equal(refused.changesBlocked.code, 'WORKSPACE_MUTATION_TERMINATION_UNCERTAIN');
  assert.equal(saved().workspaces.sub, undefined);
  assert.equal(inspectWorkspaceFolder(readConfig(), '', plain).changesBlocked, null, 'other folders are not blocked');
  const forced = registerWorkspace('sub', sub, { allowBlocked: true });
  assert.equal(forced.ok, true);
  assert.match(forced.notes.join('\n'), /Changes blocked/);
  assert.equal(saved().workspaces.sub.path, sub);
  assert.equal(fs.readdirSync(recordDir).length, 1, 'registration never removes recovery records');

  // A live holder of the edit lock makes both the CLI path and the dashboard editor fail fast.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'held-elsewhere' }));
  assert.throws(() => registerWorkspace('plain', plain), code('CONFIG_EDIT_BUSY'));
  assert.throws(() => updateWorkspace(readConfig(), { action: 'upsert', alias: 'plain', workspaceConfig: { mode: 'create', path: plain } }), code('CONFIG_EDIT_BUSY'));
  assert.equal(saved().workspaces.plain, undefined);

  // A lock left by an exited process is reclaimed once.
  const exited = spawnSync(process.execPath, ['-e', '']);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: exited.pid, token: 'stale' }));
  assert.equal(registerWorkspace('plain', plain).ok, true);
  assert.equal(fs.existsSync(lockPath), false);

  // A write is refused when config.json changed after it was read.
  const stat = fs.statSync(configPath, { bigint: true });
  const snapshot = { exists: true, mtimeNs: stat.mtimeNs, size: stat.size };
  assertConfigUnchanged(snapshot, configPath);
  fs.appendFileSync(configPath, '\n');
  assert.throws(() => assertConfigUnchanged(snapshot, configPath), code('CONFIG_CHANGED_CONCURRENTLY'));
  assert.throws(() => assertConfigUnchanged({ exists: false }, configPath), code('CONFIG_CHANGED_CONCURRENTLY'));

  console.log('workspace registration unit tests passed');
} finally {
  if (previous.config === undefined) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previous.config;
  if (previous.state === undefined) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = previous.state;
  fs.rmSync(tmp, { recursive: true, force: true });
}
