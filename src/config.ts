import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { DeployKitProps } from './types';

const namePattern = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const databaseNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
  message: 'Environment variable names must contain only letters, numbers, and underscores.',
});

const containerSchema = z
  .object({
    directory: z.string().min(1).optional(),
    image: z.string().min(1).optional(),
    dockerfile: z.string().min(1).optional(),
    buildArgs: z.record(z.string(), z.string()).default({}),
    port: z.int().min(1).max(65535).default(3000),
    healthCheckPath: z.string().startsWith('/').default('/health'),
    command: z.array(z.string()).min(1).optional(),
    environment: z.record(environmentNameSchema, z.string()).default({}),
    secrets: z
      .record(
        environmentNameSchema,
        z.object({
          secretArn: z.string().regex(/^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:.+$/),
          jsonField: z.string().min(1).optional(),
        }),
      )
      .default({}),
    architecture: z.enum(['ARM64', 'X86_64']).default('X86_64'),
  })
  .superRefine((value, context) => {
    if (Boolean(value.directory) === Boolean(value.image)) {
      context.addIssue({
        code: 'custom',
        message: 'Set exactly one of container.directory or container.image.',
      });
    }
    if (value.dockerfile && !value.directory) {
      context.addIssue({
        code: 'custom',
        message: 'container.dockerfile requires container.directory.',
        path: ['dockerfile'],
      });
    }
  });

export const deployKitConfigSchema = z.object({
  name: z.string().regex(namePattern, {
    message: 'Use 3-40 lowercase letters, numbers, or hyphens; start with a letter.',
  }),
  stage: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,19}$/)
    .default('dev'),
  account: z
    .string()
    .regex(/^\d{12}$/)
    .optional(),
  region: z
    .string()
    .regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/)
    .default('us-east-1'),
  container: containerSchema,
  network: z
    .object({
      maxAzs: z.int().min(2).max(3).default(2),
      natGateways: z.int().min(1).max(3).default(1),
      vpcCidr: z.string().default('10.42.0.0/16'),
    })
    .prefault({}),
  service: z
    .object({
      cpu: z
        .union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)])
        .default(512),
      memoryMiB: z.int().min(512).max(30_720).default(1024),
      desiredCount: z.int().min(1).max(100).default(2),
      minCapacity: z.int().min(1).max(100).default(2),
      maxCapacity: z.int().min(1).max(100).default(6),
      cpuTargetUtilization: z.number().min(10).max(90).default(60),
      memoryTargetUtilization: z.number().min(10).max(90).default(70),
      healthCheckGracePeriodSeconds: z.int().min(0).max(3600).default(60),
      enableExecuteCommand: z.boolean().default(false),
    })
    .prefault({})
    .superRefine((service, context) => {
      if (!isValidFargateSize(service.cpu, service.memoryMiB)) {
        context.addIssue({
          code: 'custom',
          message: `Invalid Fargate size: ${service.cpu} CPU units with ${service.memoryMiB} MiB memory.`,
          path: ['memoryMiB'],
        });
      }
    })
    .refine((service) => service.minCapacity <= service.desiredCount, {
      message: 'service.minCapacity must be less than or equal to service.desiredCount.',
      path: ['minCapacity'],
    })
    .refine((service) => service.desiredCount <= service.maxCapacity, {
      message: 'service.desiredCount must be less than or equal to service.maxCapacity.',
      path: ['desiredCount'],
    }),
  database: z
    .object({
      enabled: z.boolean().default(true),
      engine: z.enum(['postgres', 'mysql']).default('postgres'),
      name: z.string().regex(databaseNamePattern).default('app'),
      username: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]{0,15}$/)
        .default('deploykit'),
      instanceType: z
        .string()
        .regex(/^[a-z0-9]+\.[a-z0-9]+$/)
        .default('t4g.micro'),
      allocatedStorageGiB: z.int().min(20).max(65_536).default(20),
      maxAllocatedStorageGiB: z.int().min(20).max(65_536).default(100),
      backupRetentionDays: z.int().min(0).max(35).optional(),
      multiAz: z.boolean().optional(),
      deletionProtection: z.boolean().optional(),
    })
    .prefault({})
    .refine((database) => database.allocatedStorageGiB <= database.maxAllocatedStorageGiB, {
      message: 'database.maxAllocatedStorageGiB must be at least allocatedStorageGiB.',
      path: ['maxAllocatedStorageGiB'],
    }),
  cdn: z
    .object({
      enabled: z.boolean().default(true),
      priceClass: z.enum(['100', '200', 'all']).default('100'),
      cache: z.boolean().default(false),
    })
    .prefault({}),
  tags: z.record(z.string(), z.string()).default({}),
});

export type DeployKitConfig = z.infer<typeof deployKitConfigSchema>;

export interface LoadedConfig {
  readonly config: DeployKitConfig;
  readonly path: string;
}

export function loadConfig(configPath = 'deploykit.config.json'): LoadedConfig {
  const absolutePath = resolve(configPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${absolutePath}: ${reason}`, { cause: error });
  }

  const result = deployKitConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid DeployKit config:\n${z.prettifyError(result.error)}`);
  }

  const baseDirectory = dirname(absolutePath);
  const config = result.data;
  if (config.container.directory && !isAbsolute(config.container.directory)) {
    config.container.directory = resolve(baseDirectory, config.container.directory);
  }

  return { config, path: absolutePath };
}

export function configToProps(config: DeployKitConfig): DeployKitProps {
  return {
    name: config.name,
    stage: config.stage,
    container: config.container,
    network: config.network,
    service: config.service,
    database: config.database,
    cdn: config.cdn,
  };
}

export function stackName(config: Pick<DeployKitConfig, 'name' | 'stage'>): string {
  const parts = `${config.name}-${config.stage}`.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = parts.map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join('');
  return `DeployKit-${name}`.slice(0, 128);
}

function isValidFargateSize(cpu: number, memoryMiB: number): boolean {
  const validMemory: Record<number, readonly number[]> = {
    256: [512, 1024, 2048],
    512: [1024, 2048, 3072, 4096],
    1024: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
    2048: Array.from({ length: 13 }, (_, index) => 4096 + index * 1024),
    4096: Array.from({ length: 23 }, (_, index) => 8192 + index * 1024),
  };
  return validMemory[cpu]?.includes(memoryMiB) ?? false;
}
