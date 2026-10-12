import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  inspectWorkspaceMutationRecovery,
  observeMutationRecoveryBoot,
  prepareWorkspaceMutationRecovery,
  reconcileWorkspaceMutationRecovery
} from '../src/mutationRecoveryCheckpoint.js';
import {
  listMutationProcessRecords,
  markCurrentMutationProcessUncertain,
  recordCurrentMutationProcess,
  runWithMutationProcessOwnership
} from '../src/mutationProcessOwnership.js';

const initial = {
  platform: 'linux',
  hostHash: 'a'.repeat(64),
  bootHash: 'b'.repeat(64)
};
const rebooted = { ...initial, bootHash: 'c'.repeat(64) };
const differentHost = { ...rebooted, hostHash: 'd'.repeat(64) };
const onBoot = boot => ({ observeBoot: () => boot });
const key = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-checkpoint-'));
  const project = path.join(temporary, 'repo');
  const stateDir = path.join(temporary, 'state');
  fs.mkdirSync(project, { mode: 0o700 });
  fs.mkdirSync(path.join(project, '.git'), { mode: 0o700 });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const config = { stateDir, workspaces: { alpha: { path: project } } };
  return {
    temporary, project, stateDir, config,
    cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }),
    addRecord: (pid = 42021) => runWithMutationProcessOwnership(config, 'alpha', () => {
      const file = recordCurrentMutationProcess(pid);
      assert.ok(file);
      assert.equal(markCurrentMutationProcessUncertain(pid, 'Test-only interrupted process tree.'), true);
      return file;
    })
  };
}

function expectedError(call, code) {
  assert.throws(call, error => error?.code === code,
    'Expected refusal: ' + code);
}

function recordArchive(config, checkpointId) {
  const checkpointFolder = path.join(config.stateDir, 'mutation-recovery-checkpoints', checkpointId);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(checkpointFolder, 'checkpoint.json'), 'utf8'));
  const entry = checkpoint.records[0];
  const file = path.join(config.stateDir, 'active-mutations-v3', key(entry.authority), entry.filename);
  const archived = path.join(checkpointFolder, 'records', key(entry.authority) + '--' + entry.filename);
  return { checkpointFolder, checkpoint, file, archived, entry };
}

{
  const x = fixture();
  try {
    const file = x.addRecord();
    const report = inspectWorkspaceMutationRecovery(x.config, 'alpha');
    assert.equal(report.recordCount, 1);
    assert.equal(report.blocked, true);
    const prepared = prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial));
    assert.ok(/^[0-9a-f]{32}$/u.test(prepared.checkpointId));
    assert.equal(fs.existsSync(file), true, 'Preparation must not remove the ownership lock.');

    expectedError(() => reconcileWorkspaceMutationRecovery(
      x.config, 'alpha', prepared.checkpointId, onBoot(initial)), 'RECOVERY_REBOOT_REQUIRED');
    expectedError(() => reconcileWorkspaceMutationRecovery(
      x.config, 'alpha', prepared.checkpointId, onBoot(differentHost)), 'RECOVERY_HOST_MISMATCH');

    const dryRun = reconcileWorkspaceMutationRecovery(
      x.config, 'alpha', prepared.checkpointId, onBoot(rebooted));
    assert.equal(dryRun.remaining, 1);
    assert.equal(dryRun.applied, false);
    expectedError(() => reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, { ...onBoot(rebooted), apply: true }),
    'RECOVERY_CONFIRMATION_REQUIRED');
    assert.equal(fs.existsSync(file), true);

    const { archived } = recordArchive(x.config, prepared.checkpointId);
    const before = fs.readFileSync(file);
    const applied = reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, { ...onBoot(rebooted), apply: true, confirm: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.remaining, 0);
    assert.equal(fs.existsSync(file), false, 'Only the exact verified record is archived.');
    assert.deepEqual(fs.readFileSync(archived), before);
    assert.deepEqual(listMutationProcessRecords(x.config, 'alpha'), []);
    const repeat = reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, { ...onBoot(rebooted), apply: true, confirm: true });
    assert.equal(repeat.archived, 1, 'Recovery can be resumed after a completion-receipt interruption.');
  } finally { x.cleanup(); }
}

{
  const x = fixture();
  try {
    const original = x.addRecord();
    const prepared = prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial));
    fs.appendFileSync(original, '\n');
    expectedError(() => reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, onBoot(rebooted)), 'RECOVERY_RECORD_CHANGED');
    assert.equal(fs.existsSync(original), true);
  } finally { x.cleanup(); }
}

{
  const x = fixture();
  try {
    const original = x.addRecord();
    const prepared = prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial));
    const saved = original + '.bak';
    fs.renameSync(original, saved);
    fs.symlinkSync(saved, original);
    expectedError(() => reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, onBoot(rebooted)), 'RECOVERY_RECORD_UNBOUND');
  } finally { x.cleanup(); }
}

{
  const x = fixture();
  try {
    x.addRecord();
    const prepared = prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial));
    x.addRecord(42022);
    expectedError(() => reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, onBoot(rebooted)), 'RECOVERY_INVENTORY_CHANGED');
    assert.equal(listMutationProcessRecords(x.config, 'alpha').length, 2);
  } finally { x.cleanup(); }
}

{
  const x = fixture();
  try {
    const original = x.addRecord();
    const prepared = prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial));
    fs.unlinkSync(original);
    expectedError(() => reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, onBoot(rebooted)), 'RECOVERY_RECORD_MISSING');
  } finally { x.cleanup(); }
}

{
  const x = fixture();
  try {
    const original = x.addRecord();
    const prepared = prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial));
    const { archived } = recordArchive(x.config, prepared.checkpointId);
    // Crash simulation: the first atomic rename happened, but the CLI never returned.
    fs.renameSync(original, archived);
    const remaining = reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, onBoot(rebooted));
    assert.equal(remaining.remaining, 0);
    assert.equal(remaining.archived, 1);
    assert.deepEqual(listMutationProcessRecords(x.config, 'alpha'), []);
  } finally { x.cleanup(); }
}

{
  const x = fixture();
  try {
    x.addRecord();
    const prepared = prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial));
    const unrelated = path.join(x.temporary, 'other');
    fs.mkdirSync(unrelated, { mode: 0o700 });
    fs.mkdirSync(path.join(unrelated, '.git'), { mode: 0o700 });
    x.config.workspaces.beta = { path: unrelated };
    const foreign = runWithMutationProcessOwnership(x.config, 'beta', () => {
      const file = recordCurrentMutationProcess(42023);
      markCurrentMutationProcessUncertain(42023, 'Independent fixture process.');
      return file;
    });
    const applied = reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, { ...onBoot(rebooted), apply: true, confirm: true });
    assert.equal(applied.applied, true);
    assert.ok(fs.existsSync(foreign), 'Other workspace ownership must remain intact.');
    assert.equal(inspectWorkspaceMutationRecovery(x.config, 'beta').recordCount, 1);
  } finally { x.cleanup(); }
}

{
  const x = fixture();
  try {
    x.addRecord();
    const prepared = prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial));
    const archiveFile = path.join(x.stateDir, 'mutation-recovery-checkpoints',
      prepared.checkpointId, 'records', 'unexpected.json');
    fs.writeFileSync(archiveFile, '{}', { mode: 0o600 });
    expectedError(() => reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, onBoot(rebooted)), 'RECOVERY_ARCHIVE_CHANGED');
  } finally { x.cleanup(); }
}

{
  const x = fixture();
  try {
    x.addRecord();
    const prepared = prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial));
    const { checkpointFolder } = recordArchive(x.config, prepared.checkpointId);
    fs.appendFileSync(path.join(checkpointFolder, 'checkpoint.json'), '\nnot-json');
    expectedError(() => reconcileWorkspaceMutationRecovery(x.config, 'alpha',
      prepared.checkpointId, onBoot(rebooted)), 'RECOVERY_INVALID_JSON');
  } finally { x.cleanup(); }
}

{
  const x = fixture();
  try {
    x.addRecord();
    expectedError(() => prepareWorkspaceMutationRecovery(x.config, 'unknown', onBoot(initial)),
      'RECOVERY_WORKSPACE_REQUIRED');
    const legacyFolder = path.join(x.stateDir, 'active-mutations', key('legacy'));
    fs.mkdirSync(path.dirname(legacyFolder), { recursive: true, mode: 0o700 });
    fs.mkdirSync(legacyFolder, { mode: 0o700 });
    fs.writeFileSync(path.join(legacyFolder, 'legacy.json'),
      JSON.stringify({ schemaVersion: 1, pid: 42024, workspace: 'old' }), { mode: 0o600 });
    expectedError(() => prepareWorkspaceMutationRecovery(x.config, 'alpha', onBoot(initial)),
      'RECOVERY_RECORD_UNBOUND');
  } finally { x.cleanup(); }
}

{
  // Real kernel inputs, but with injectable command/read adapters: no fake data
  // injection enters the operator CLI.
  const expected = observeMutationRecoveryBoot({
    platform: 'darwin',
    exec(file, args) {
      if (file.endsWith('/ioreg')) return '"IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"';
      if (args[1] === 'kern.bootsessionuuid')
        return 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE\n';
      throw new Error('Unexpected command');
    }
  });
  assert.equal(expected.platform, 'darwin');
  assert.equal(expected.hostHash.length, 64);
  assert.equal(expected.bootHash.length, 64);
  expectedError(() => observeMutationRecoveryBoot({
    platform: 'darwin', exec() { throw new Error('Sandbox denied'); }
  }), 'RECOVERY_BOOT_UNAVAILABLE');
  expectedError(() => observeMutationRecoveryBoot({
    platform: 'win32'
  }), 'RECOVERY_PLATFORM_UNSUPPORTED');
}

console.log('Mutation recovery checkpoints require a verified reboot, preserve exact archive bytes, and reject changed, missing, legacy, or foreign records.');
