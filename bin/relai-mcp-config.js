#!/usr/bin/env node
import * as path from 'node:path';
import { Command } from 'commander';
import { readConfig, writeConfig, getConfigPath, makeDefaultConfig } from '../src/config.js';
import * as productUx from '../src/productUx.js';
import {
  inspectWorkspaceMutationRecovery,
  prepareWorkspaceMutationRecovery,
  reconcileWorkspaceMutationRecovery
} from '../src/mutationRecoveryCheckpoint.js';

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

const program = new Command()
  .name('relai-mcp-config')
  .description('Manage Rel.AI MCP configuration and local workspace setup.')
  .showHelpAfterError()
  .addHelpText('after', `\nConfig path: ${getConfigPath()}`);

program
  .command('init')
  .description('Create the default configuration file.')
  .action(() => {
    writeConfig(makeDefaultConfig(), { overwrite: false });
    console.log(`Created config at ${getConfigPath()}`);
  });

program
  .command('show')
  .description('Print the normalized configuration.')
  .action(() => printJson(readConfig()));

program
  .command('doctor [workspace-path]')
  .description('Inspect local Rel.AI health and optionally apply supported fixes.')
  .option('--fix', 'Apply supported fixes.')
  .action(async (workspacePath, options) => {
    const config = readConfig({ allowMissing: true });
    const result = options.fix
      ? await productUx.doctorFix(config, { workspacePath, overwrite: false })
      : await productUx.healthMonitor(config, {});
    printJson(result);
  });

program
  .command('setup [alias] [workspace-path]')
  .description('Run the local setup wizard.')
  .action((alias = 'myapp', workspacePath = '') => {
    printJson(productUx.setupWizard({ alias, workspacePath }));
  });

const state = program.command('state').description('Export or import Rel.AI local state.');
state
  .command('export <output-path>')
  .description('Export local state to a file.')
  .action(outputPath => printJson(productUx.stateExport(readConfig(), { outputPath })));
state
  .command('import <input-path>')
  .description('Import local state from a file.')
  .option('--confirm', 'Confirm the state import.')
  .action((inputPath, options) => printJson(productUx.stateImport(readConfig(), {
    inputPath,
    confirm: options.confirm === true
  })));

// Local operator workflow only: no MCP action can submit a forged reboot assertion.
// The default command never modifies a recovery record. Explicit apply remains
// behind a same-host OS-boot change, exact inventory revalidation and --confirm.
const recovery = program.command('mutation-recovery')
  .description('Inspect and safely reconcile uncertain process ownership after an OS reboot.');
recovery.command('inspect <alias>')
  .description('Read-only inventory of uncertain process records for one configured workspace.')
  .action(alias => printJson(inspectWorkspaceMutationRecovery(readConfig(), alias)));
recovery.command('prepare <alias>')
  .description('Durably capture exact records and the current boot identity before rebooting.')
  .action(alias => printJson(prepareWorkspaceMutationRecovery(readConfig(), alias)));
recovery.command('preview <alias> <checkpoint-id>')
  .description('After reboot, verify the machine, boot and unchanged exact record inventory.')
  .action((alias, checkpointId) => printJson(reconcileWorkspaceMutationRecovery(
    readConfig(), alias, checkpointId)));
recovery.command('apply <alias> <checkpoint-id>')
  .description('Archive only checkpoint-verified records after a full same-host OS reboot.')
  .requiredOption('--confirm', 'Explicitly acknowledge archival of the exact checked records.')
  .action((alias, checkpointId, options) => printJson(reconcileWorkspaceMutationRecovery(
    readConfig(), alias, checkpointId, { apply: true, confirm: options.confirm === true })));

const workspace = program.command('workspace').description('Manage authorized workspaces.');
workspace
  .command('add <alias> <absolute-path>')
  .description('Add or update an authorized workspace.')
  .action((alias, workspacePath) => {
    if (!path.isAbsolute(workspacePath)) throw new Error('Workspace path must be absolute.');
    const config = readConfig({ allowMissing: true });
    config.workspaces = config.workspaces || {};
    config.workspaces[alias] = { ...(config.workspaces[alias] || {}), path: workspacePath };
    writeConfig(config);
    console.log(`Added workspace '${alias}' -> ${workspacePath}`);
  });

try {
  if (process.argv.length <= 2) program.help();
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
