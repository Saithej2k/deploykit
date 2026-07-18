#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, stackName } from './config';

const VERSION = '0.1.0';
const CDK_PATH = require.resolve('aws-cdk/bin/cdk');
const CDK_APP_PATH = resolve(__dirname, 'cdk-app.js');

interface ParsedArguments {
  readonly command: string;
  readonly configPath: string;
  readonly bootstrap: boolean;
  readonly cdkArguments: readonly string[];
}

function main(): number {
  const parsed = parseArguments(process.argv.slice(2));

  if (['help', '--help', '-h'].includes(parsed.command)) {
    printHelp();
    return 0;
  }
  if (['version', '--version', '-v'].includes(parsed.command)) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!['bootstrap', 'deploy', 'destroy', 'diff', 'doctor', 'synth'].includes(parsed.command)) {
    process.stderr.write(`Unknown command: ${parsed.command}\n\n`);
    printHelp(process.stderr);
    return 2;
  }

  let loaded;
  try {
    loaded = loadConfig(parsed.configPath);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.command === 'doctor') {
    return doctor(loaded.path, loaded.config.container.directory);
  }

  const appCommand = `${shellEscape(process.execPath)} ${shellEscape(CDK_APP_PATH)}`;
  const environment = {
    ...process.env,
    DEPLOYKIT_CONFIG: loaded.path,
  };

  if (parsed.command === 'bootstrap') {
    return runCdk(['bootstrap', '--app', appCommand, ...parsed.cdkArguments], environment);
  }

  if (parsed.command === 'deploy' && parsed.bootstrap) {
    process.stdout.write(
      `\nDeployKit: checking the CDK bootstrap stack in ${loaded.config.region}...\n\n`,
    );
    const bootstrapStatus = runCdk(
      ['bootstrap', '--app', appCommand, ...bootstrapPassthrough(parsed.cdkArguments)],
      environment,
    );
    if (bootstrapStatus !== 0) return bootstrapStatus;
  }

  const deploymentArguments = [...parsed.cdkArguments];
  if (
    parsed.command === 'deploy' &&
    !deploymentArguments.some((argument) => argument.startsWith('--require-approval'))
  ) {
    deploymentArguments.push('--require-approval', 'broadening');
  }

  return runCdk(
    [parsed.command, stackName(loaded.config), '--app', appCommand, ...deploymentArguments],
    environment,
  );
}

function parseArguments(arguments_: readonly string[]): ParsedArguments {
  const values = [...arguments_];
  const command = values.shift() ?? 'help';
  let configPath = process.env.DEPLOYKIT_CONFIG ?? 'deploykit.config.json';
  let bootstrap = true;
  const cdkArguments: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index] as string;
    if (argument === '--config') {
      const value = values[index + 1];
      if (!value) throw new Error('--config requires a file path.');
      configPath = value;
      index += 1;
    } else if (argument.startsWith('--config=')) {
      configPath = argument.slice('--config='.length);
    } else if (argument === '--no-bootstrap') {
      bootstrap = false;
    } else {
      cdkArguments.push(argument);
    }
  }

  return { bootstrap, cdkArguments, command, configPath };
}

function runCdk(arguments_: readonly string[], environment: NodeJS.ProcessEnv): number {
  const result = spawnSync(process.execPath, [CDK_PATH, ...arguments_], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`Could not start AWS CDK: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function bootstrapPassthrough(arguments_: readonly string[]): string[] {
  const result: string[] = [];
  const optionsWithValues = new Set(['--context', '--profile', '-c']);

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (optionsWithValues.has(argument)) {
      const value = arguments_[index + 1];
      if (value) {
        result.push(argument, value);
        index += 1;
      }
    } else if (['--context=', '--profile='].some((prefix) => argument.startsWith(prefix))) {
      result.push(argument);
    }
  }

  return result;
}

function doctor(configPath: string, containerDirectory?: string): number {
  const checks: Array<readonly [string, boolean, string]> = [
    ['Node.js 20 or newer', Number(process.versions.node.split('.')[0]) >= 20, process.version],
    ['DeployKit config', existsSync(configPath), configPath],
    ['AWS CDK CLI', existsSync(CDK_PATH), CDK_PATH],
  ];
  if (containerDirectory) {
    checks.push(['Container directory', existsSync(containerDirectory), containerDirectory]);
    const docker = spawnSync('docker', ['--version'], { encoding: 'utf8' });
    checks.push([
      'Docker',
      docker.status === 0,
      docker.status === 0 ? docker.stdout.trim() : 'not found or not running',
    ]);
  }

  for (const [label, success, detail] of checks) {
    process.stdout.write(`${success ? 'OK' : 'FAIL'}  ${label}: ${detail}\n`);
  }
  process.stdout.write(
    '\nAWS credentials are resolved by the CDK credential provider. Run `aws configure` or set AWS_PROFILE before deployment.\n',
  );
  return checks.every(([, success]) => success) ? 0 : 1;
}

function shellEscape(value: string): string {
  return value.replace(/([\\\s"'$`])/g, '\\$1');
}

function printHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`DeployKit ${VERSION}

Usage:
  deploykit <command> [--config path] [CDK options]

Commands:
  doctor      Validate the local setup and configuration
  bootstrap   Bootstrap the configured AWS environment
  synth       Generate the CloudFormation template
  diff        Compare the deployed stack with local code
  deploy      Bootstrap and deploy the complete stack
  destroy     Remove the stack (production databases are retained)
  version     Print the version

Options:
  --config <path>   Config file (default: deploykit.config.json)
  --no-bootstrap    Skip the automatic bootstrap before deploy

Examples:
  deploykit deploy
  deploykit deploy --config deploykit.prod.json --profile production
  deploykit synth --quiet
`);
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
