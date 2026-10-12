import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getStateDir } from './statePaths.js';
import { canonicalWorkspaceAuthority } from './workspaceOperationQueue.js';
import { listMutationProcessRecords } from './mutationProcessOwnership.js';

const MAX_RECORDS = 1000;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const CHECKPOINT_ID = /^[0-9a-f]{32}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RECORD_NAME = /^[A-Za-z0-9_-]{1,200}\.json$/u;
const execFileAsync = promisify(execFile);

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * A stable machine identifier AND a kernel-issued identifier that changes on
 * reboot. Missing or inaccessible OS facts fail closed; neither user-entered
 * timestamps nor PID disappearance is accepted as reboot evidence.
 */
async function observeMutationRecoveryBoot({
  platform = process.platform,
  exec = async (command, argv) => {
    const { stdout } = await execFileAsync(command, argv, {
      encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024,
      windowsHide: true
    });
    return stdout;
  },
  read = file => fs.promises.readFile(file, 'utf8')
} = {}) {
  let host;
  let boot;
  try {
    if (platform === 'darwin') {
      const registry = await exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      host = /"IOPlatformUUID"\s*=\s*"([0-9a-f-]+)"/iu.exec(registry)?.[1];
      for (const name of ['kern.bootsessionuuid', 'kern.bootuuid']) {
        try {
          const value = (await exec('/usr/sbin/sysctl', ['-n', name])).trim();
          if (UUID.test(value)) { boot = value; break; }
        } catch { /* Another documented boot UUID may be available. */ }
      }
      if (!UUID.test(host || '') || !UUID.test(boot || ''))
        throw new Error('Invalid native macOS identity');
    } else if (platform === 'linux') {
      host = (await read('/etc/machine-id')).trim();
      boot = (await read('/proc/sys/kernel/random/boot_id')).trim();
      if (!/^[0-9a-f]{32}$/iu.test(host) || !UUID.test(boot))
        throw new Error('Invalid native Linux identity');
    } else {
      reject('RECOVERY_PLATFORM_UNSUPPORTED',
        'Mutation recovery is supported only on macOS and Linux.');
    }
  } catch (error) {
    if (error?.code === 'RECOVERY_PLATFORM_UNSUPPORTED') throw error;
    reject('RECOVERY_BOOT_UNAVAILABLE',
      'Cannot verify native machine and boot identities; records remain blocked.');
  }
  if (/^0+$/u.test(host.replaceAll('-', '')) ||
      /^0+$/u.test(boot.replaceAll('-', '')))
    reject('RECOVERY_BOOT_UNAVAILABLE', 'The OS returned an unusable identity.');
  return {
    platform,
    hostHash: hash(platform + ':' + host.toLowerCase()),
    bootHash: hash(platform + ':' + boot.toLowerCase())
  };
}

function checkedDirectory(directory, create = false) {
  if (create) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
    reject('RECOVERY_UNSAFE_DIRECTORY',
      'Recovery requires user-owned, non-writable-by-others directories without symlinks.');
  return directory;
}

function readExactFile(file, maxBytes = MAX_RECORD_BYTES) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() ||
      before.nlink !== 1 || before.size > maxBytes ||
      (before.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid()))
    reject('RECOVERY_UNSAFE_FILE', 'Unsafe, oversized or multiply-linked recovery file.');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (stat.dev !== before.dev || stat.ino !== before.ino ||
        stat.size !== before.size || stat.size > maxBytes)
      reject('RECOVERY_RECORD_CHANGED', 'A recovery record changed during inspection.');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const named = fs.lstatSync(file);
    if (bytes.length !== stat.size || after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs ||
        named.dev !== stat.dev || named.ino !== stat.ino || named.isSymbolicLink())
      reject('RECOVERY_RECORD_CHANGED', 'A recovery record changed during inspection.');
    return {
      bytes, digest: hash(bytes),
      dev: String(stat.dev), ino: String(stat.ino)
    };
  } finally { fs.closeSync(descriptor); }
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { reject('RECOVERY_INVALID_JSON', 'Recovery metadata is not valid JSON.'); }
}

function writeExclusive(file, object) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(object, null, 2) + '\n');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function workspaceContext(config, alias) {
  if (typeof alias !== 'string' || !alias ||
      !Object.prototype.hasOwnProperty.call(config?.workspaces || {}, alias))
    reject('RECOVERY_WORKSPACE_REQUIRED', 'Select an existing configured workspace alias.');
  const configured = config.workspaces[alias]?.path;
  if (typeof configured !== 'string' || !path.isAbsolute(configured))
    reject('RECOVERY_WORKSPACE_REQUIRED', 'The workspace must have an absolute configured path.');
  const physical = fs.realpathSync.native(configured);
  const authorities = [...new Set([
    canonicalWorkspaceAuthority(physical),
    'path:' + (process.platform === 'win32' ? physical.toLowerCase() : physical)
  ])];
  const state = getStateDir(config);
  if (!path.isAbsolute(state))
    reject('RECOVERY_STATE_ROOT_AMBIGUOUS', 'State directory must have an absolute path.');
  checkedDirectory(state);
  const mutationRoot = path.join(state, 'active-mutations-v3');
  // An unused workspace has no mutation directory. Inspect must report zero
  // records rather than require a previous mutating command to have run.
  if (fs.existsSync(mutationRoot)) checkedDirectory(mutationRoot);
  return {
    config, alias, authorities, state, mutationRoot,
    checkpoints: path.join(state, 'mutation-recovery-checkpoints')
  };
}

function checkedRecordPath(context, record) {
  if (record.invalid || record.incomplete || record.legacyAuthorityUnknown ||
      record.authorityStatus !== 'bound' ||
      !context.authorities.includes(record.authority) ||
      record.schemaVersion !== 3 || record.terminationUncertain !== true)
    reject('RECOVERY_RECORD_UNBOUND',
      'Invalid, incomplete, legacy or foreign records require separate operator review.');
  const directory = path.join(context.mutationRoot, hash(record.authority));
  checkedDirectory(directory);
  const filename = path.basename(record.file || '');
  if (!RECORD_NAME.test(filename) ||
      path.resolve(record.file || '') !== path.join(directory, filename))
    reject('RECOVERY_RECORD_SCOPE', 'A record is not confined to its physical workspace.');
  return { directory, filename, file: path.join(directory, filename) };
}

function recordSnapshot(context, record) {
  const location = checkedRecordPath(context, record);
  const raw = readExactFile(location.file);
  const parsed = parseJson(raw.bytes);
  if (parsed.schemaVersion !== 3 ||
      parsed.authority !== record.authority ||
      parsed.authorityStatus !== 'bound' ||
      parsed.terminationUncertain !== true ||
      !Number.isSafeInteger(parsed.pid) || parsed.pid < 0 ||
      (parsed.pid === 0 && parsed.phase !== 'preparing') ||
      !['active', 'preparing', 'uncertain'].includes(parsed.phase) ||
      parsed.runtimeId !== record.runtimeId)
    reject('RECOVERY_RECORD_INVALID', 'Record ownership or process state is inconsistent.');
  return {
    authority: record.authority, filename: location.filename,
    digest: raw.digest, dev: raw.dev, ino: raw.ino
  };
}

function exactInventory(context) {
  const records = listMutationProcessRecords(context.config, context.alias);
  if (!Array.isArray(records) || records.length > MAX_RECORDS)
    reject('RECOVERY_INVENTORY_INCOMPLETE', 'Recovery inventory is incomplete.');
  const seen = new Set();
  const snapshots = records.map(record => {
    const entry = recordSnapshot(context, record);
    const key = entry.authority + '/' + entry.filename;
    if (seen.has(key)) reject('RECOVERY_DUPLICATE_RECORD', 'Duplicate recovery record.');
    seen.add(key);
    return entry;
  });
  for (const authority of context.authorities) {
    const directory = path.join(context.mutationRoot, hash(authority));
    if (!fs.existsSync(directory)) continue;
    checkedDirectory(directory);
    const names = fs.readdirSync(directory);
    if (names.some(name => name.endsWith('.json') &&
        !seen.has(authority + '/' + name)))
      reject('RECOVERY_INVENTORY_CHANGED', 'Recovery inventory changed during inspection.');
  }
  return snapshots.sort((a, b) =>
    (a.authority + a.filename).localeCompare(b.authority + b.filename, 'en'));
}

function checkpointDir(context, id, create = false) {
  if (!CHECKPOINT_ID.test(id || ''))
    reject('RECOVERY_CHECKPOINT_INVALID', 'Checkpoint ID is invalid.');
  checkedDirectory(context.checkpoints, create);
  const directory = checkedDirectory(path.join(context.checkpoints, id), create);
  const archive = checkedDirectory(path.join(directory, 'records'), create);
  return { directory, archive };
}

function readCheckpoint(context, id) {
  const paths = checkpointDir(context, id);
  const checkpoint = parseJson(readExactFile(
    path.join(paths.directory, 'checkpoint.json'), MAX_CHECKPOINT_BYTES).bytes);
  if (checkpoint.version !== 1 || checkpoint.id !== id ||
      checkpoint.alias !== context.alias ||
      !Array.isArray(checkpoint.authorities) ||
      checkpoint.authorities.length !== context.authorities.length ||
      !context.authorities.every(a => checkpoint.authorities.includes(a)) ||
      !Array.isArray(checkpoint.records) ||
      checkpoint.records.length < 1 || checkpoint.records.length > MAX_RECORDS ||
      !checkpoint.boot ||
      !['darwin', 'linux'].includes(checkpoint.boot.platform) ||
      !HEX64.test(checkpoint.boot.hostHash || '') ||
      !HEX64.test(checkpoint.boot.bootHash || ''))
    reject('RECOVERY_CHECKPOINT_INVALID', 'Checkpoint does not match this workspace.');
  const seen = new Set();
  for (const entry of checkpoint.records) {
    if (!context.authorities.includes(entry.authority) ||
        !RECORD_NAME.test(entry.filename || '') ||
        !HEX64.test(entry.digest || '') ||
        !/^\d+$/u.test(entry.dev || '') ||
        !/^\d+$/u.test(entry.ino || ''))
      reject('RECOVERY_CHECKPOINT_INVALID', 'Invalid checkpoint record identity.');
    const key = entry.authority + '/' + entry.filename;
    if (seen.has(key)) reject('RECOVERY_CHECKPOINT_INVALID', 'Duplicate checkpoint identity.');
    seen.add(key);
  }
  return { ...paths, checkpoint };
}

function existsNoFollow(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function checkedMatchingFile(file, entry) {
  const fileState = readExactFile(file);
  const data = parseJson(fileState.bytes);
  if (fileState.digest !== entry.digest ||
      fileState.dev !== entry.dev || fileState.ino !== entry.ino ||
      data.schemaVersion !== 3 || data.authority !== entry.authority ||
      data.authorityStatus !== 'bound' || data.terminationUncertain !== true)
    reject('RECOVERY_RECORD_CHANGED', 'Captured record was replaced or altered.');
}

function verifyAfterReboot(context, state, currentBoot) {
  const { checkpoint, archive } = state;
  if (currentBoot.platform !== checkpoint.boot.platform ||
      currentBoot.hostHash !== checkpoint.boot.hostHash)
    reject('RECOVERY_HOST_MISMATCH', 'The checkpoint was taken on another computer.');
  if (currentBoot.bootHash === checkpoint.boot.bootHash)
    reject('RECOVERY_REBOOT_REQUIRED',
      'A full OS reboot is required after preparing the checkpoint; PID disappearance is insufficient.');
  const active = exactInventory(context);
  const expected = new Set(checkpoint.records.map(r => r.authority + '/' + r.filename));
  const activeKeys = new Set(active.map(r => r.authority + '/' + r.filename));
  if (active.some(r => !expected.has(r.authority + '/' + r.filename)))
    reject('RECOVERY_INVENTORY_CHANGED', 'New process records appeared after preparation.');
  const archiveNames = fs.readdirSync(archive);
  const remaining = [];
  for (const item of checkpoint.records) {
    const relative = hash(item.authority) + '--' + item.filename;
    const archived = path.join(archive, relative);
    const original = path.join(context.mutationRoot, hash(item.authority), item.filename);
    const hasOriginal = existsNoFollow(original);
    const hasArchived = existsNoFollow(archived);
    if (hasOriginal === hasArchived)
      reject('RECOVERY_RECORD_MISSING',
        'A captured record is duplicated or missing; manual review required.');
    const key = item.authority + '/' + item.filename;
    if (hasOriginal !== activeKeys.has(key))
      reject('RECOVERY_INVENTORY_CHANGED', 'On-disk record and inventory disagree.');
    checkedMatchingFile(hasOriginal ? original : archived, item);
    if (hasOriginal) remaining.push({ item, original, archived });
  }
  const allowedArchives = new Set(checkpoint.records.map(
    item => hash(item.authority) + '--' + item.filename));
  if (archiveNames.some(name => !allowedArchives.has(name)))
    reject('RECOVERY_ARCHIVE_CHANGED', 'Unexpected file in the checkpoint archive.');
  return { remaining, checkpoint, archive };
}

/** Read-only overview; no PID absence or elapsed-time inference is made. */
function inspectWorkspaceMutationRecovery(config, alias) {
  const context = workspaceContext(config, alias);
  const records = exactInventory(context);
  return {
    workspace: alias, recordCount: records.length,
    blocked: records.length > 0,
    rebootRequiredForRecovery: records.length > 0,
    message: 'This is an inventory, not confirmation that a process tree stopped.'
  };
}

/** Prepare durable exact-record evidence BEFORE the OS reboot. */
async function prepareWorkspaceMutationRecovery(config, alias, options = {}) {
  const context = workspaceContext(config, alias);
  const records = exactInventory(context);
  if (!records.length)
    reject('RECOVERY_NO_RECORDS', 'There are no uncertain process records to reconcile.');
  const boot = await (options.observeBoot || observeMutationRecoveryBoot)();
  const id = crypto.randomBytes(16).toString('hex');
  const paths = checkpointDir(context, id, true);
  writeExclusive(path.join(paths.directory, 'checkpoint.json'), {
    version: 1, id, alias, authorities: context.authorities,
    capturedAt: new Date().toISOString(), boot, records
  });
  syncDirectory(paths.directory);
  syncDirectory(context.checkpoints);
  return {
    checkpointId: id, workspace: alias, recordCount: records.length,
    applied: false, recoveryRequired: true,
    nextStep: 'Reboot this computer, then run mutation-recovery preview. Restarting only Rel.AI is insufficient.'
  };
}

/** Preview or archive exact records after a verified same-host reboot. */
async function reconcileWorkspaceMutationRecovery(config, alias, id, options = {}) {
  const context = workspaceContext(config, alias);
  const paths = readCheckpoint(context, id);
  const boot = await (options.observeBoot || observeMutationRecoveryBoot)();
  const report = verifyAfterReboot(context, paths, boot);
  const base = {
    checkpointId: id, workspace: alias, total: report.checkpoint.records.length,
    remaining: report.remaining.length,
    archived: report.checkpoint.records.length - report.remaining.length,
    evidence: 'same-host-os-boot-changed', applied: false
  };
  if (!options.apply) return base;
  if (options.confirm !== true)
    reject('RECOVERY_CONFIRMATION_REQUIRED', 'Explicit local operator confirmation is required.');

  // Durable audit before mutation; no process signals, task success, or Git changes.
  if (!report.remaining.length) return { ...base, applied: true };
  const audit = path.join(paths.directory,
    'attempt-' + crypto.randomBytes(12).toString('hex') + '.json');
  writeExclusive(audit, {
    version: 1, checkpointId: id, verifiedAt: new Date().toISOString(),
    boot, records: report.remaining.map(r => hash(r.item.authority) + '--' + r.item.filename)
  });
  syncDirectory(paths.directory);
  for (const { item, original, archived } of report.remaining) {
    checkedMatchingFile(original, item);
    if (existsNoFollow(archived))
      reject('RECOVERY_ARCHIVE_CHANGED', 'An archive entry appeared during reconciliation.');
    // Moving, never deleting, keeps the exact original bytes for audit/reversal.
    fs.renameSync(original, archived);
    syncDirectory(path.dirname(original));
    syncDirectory(report.archive);
  }
  return { ...base, remaining: 0, archived: base.total, applied: true,
    nextStep: 'Restart Rel.AI and verify workspace readiness before resuming builds. Interrupted work was NOT marked successful.' };
}

export {
  observeMutationRecoveryBoot,
  inspectWorkspaceMutationRecovery,
  prepareWorkspaceMutationRecovery,
  reconcileWorkspaceMutationRecovery
};
