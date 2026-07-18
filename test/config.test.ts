import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, stackName } from '../src/config';

function writeConfig(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'deploykit-config-'));
  const path = join(directory, 'deploykit.config.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('loadConfig', () => {
  it('applies defaults and resolves the Docker directory from the config location', () => {
    const path = writeConfig({
      name: 'orders-api',
      container: { directory: './app' },
    });

    const loaded = loadConfig(path);

    expect(loaded.config.stage).toBe('dev');
    expect(loaded.config.region).toBe('us-east-1');
    expect(loaded.config.container.port).toBe(3000);
    expect(loaded.config.container.directory).toBe(join(path, '..', 'app'));
    expect(loaded.config.database.enabled).toBe(true);
  });

  it('rejects ambiguous container sources', () => {
    const path = writeConfig({
      name: 'orders-api',
      container: { directory: './app', image: 'nginx:stable' },
    });

    expect(() => loadConfig(path)).toThrow('Set exactly one');
  });

  it('rejects inconsistent service scaling limits', () => {
    const path = writeConfig({
      name: 'orders-api',
      container: { image: 'nginx:stable' },
      service: { desiredCount: 2, minCapacity: 3, maxCapacity: 4 },
    });

    expect(() => loadConfig(path)).toThrow('minCapacity');
  });

  it('rejects unsupported Fargate CPU and memory pairs before synthesis', () => {
    const path = writeConfig({
      name: 'orders-api',
      container: { image: 'nginx:stable' },
      service: { cpu: 256, memoryMiB: 4096 },
    });

    expect(() => loadConfig(path)).toThrow('Invalid Fargate size');
  });
});

describe('stackName', () => {
  it('creates a stable CloudFormation stack name', () => {
    expect(stackName({ name: 'orders-api', stage: 'prod' })).toBe('DeployKit-OrdersApiProd');
  });
});
