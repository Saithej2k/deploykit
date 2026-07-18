import type { IVpc } from 'aws-cdk-lib/aws-ec2';

export type CpuArchitecture = 'ARM64' | 'X86_64';
export type DatabaseEngine = 'mysql' | 'postgres';
export type CloudFrontPriceClass = '100' | '200' | 'all';

export interface ContainerSecret {
  /** Full ARN of an existing Secrets Manager secret. */
  readonly secretArn: string;
  /** Optional JSON key within the secret. */
  readonly jsonField?: string;
}

export interface DeployKitContainerOptions {
  /** Local directory to build with Docker. Mutually exclusive with image. */
  readonly directory?: string;
  /** Registry image such as public.ecr.aws/nginx/nginx:stable. */
  readonly image?: string;
  readonly dockerfile?: string;
  readonly buildArgs?: Readonly<Record<string, string>>;
  readonly port?: number;
  readonly healthCheckPath?: string;
  readonly command?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, ContainerSecret>>;
  readonly architecture?: CpuArchitecture;
}

export interface DeployKitNetworkOptions {
  readonly maxAzs?: number;
  readonly natGateways?: number;
  readonly vpcCidr?: string;
}

export interface DeployKitServiceOptions {
  readonly cpu?: number;
  readonly memoryMiB?: number;
  readonly desiredCount?: number;
  readonly minCapacity?: number;
  readonly maxCapacity?: number;
  readonly cpuTargetUtilization?: number;
  readonly memoryTargetUtilization?: number;
  readonly healthCheckGracePeriodSeconds?: number;
  readonly enableExecuteCommand?: boolean;
}

export interface DeployKitDatabaseOptions {
  readonly enabled?: boolean;
  readonly engine?: DatabaseEngine;
  readonly name?: string;
  readonly username?: string;
  readonly instanceType?: string;
  readonly allocatedStorageGiB?: number;
  readonly maxAllocatedStorageGiB?: number;
  readonly backupRetentionDays?: number;
  readonly multiAz?: boolean;
  readonly deletionProtection?: boolean;
}

export interface DeployKitCdnOptions {
  readonly enabled?: boolean;
  readonly priceClass?: CloudFrontPriceClass;
  readonly cache?: boolean;
}

export interface DeployKitProps {
  readonly name: string;
  readonly stage?: string;
  readonly container: DeployKitContainerOptions;
  readonly network?: DeployKitNetworkOptions;
  readonly service?: DeployKitServiceOptions;
  readonly database?: DeployKitDatabaseOptions;
  readonly cdn?: DeployKitCdnOptions;
  /** Bring an existing VPC when using DeployKit as a construct. */
  readonly vpc?: IVpc;
}
