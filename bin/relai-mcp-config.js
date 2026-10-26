#!/usr/bin/env node
import * as path from 'node:path';
import { Command } from 'commander';
import { readConfig, writeConfig, getConfigPath, makeDefaultConfig } from '../src/config.js';
import * as productUx from '../src/productUx.js';
import { inspectWorkspaceFolder, registerWorkspace } from '../src/workspaceRegistration.js';

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

const workspace = program.command('workspace').description('Manage authorized workspaces.');
workspace
  .command('add <alias> <absolute-path>')
  .description('Add an authorized workspace: validated, locked against other config edits, written atomically.')
  .option('--update', 'Change an existing workspace instead of refusing.')
  .option('--dry-run', 'Validate and report without writing.')
  .option('--allow-blocked', "Add even if the folder's change lock is currently blocked.")
  .action((alias, workspacePath, options) => {
    const result = registerWorkspace(alias, workspacePath, {
      update: options.update === true,
      dryRun: options.dryRun === true,
      allowBlocked: options.allowBlocked === true
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  });
workspace
  .command('check <absolute-path>')
  .description("Report which workspaces share a folder's change lock and whether it is blocked. Read-only.")
  .action(workspacePath => {
    if (!path.isAbsolute(workspacePath)) throw new Error('Workspace path must be absolute.');
    printJson(inspectWorkspaceFolder(readConfig({ allowMissing: true }), '', workspacePath));
  });

try {
  if (process.argv.length <= 2) program.help();
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
