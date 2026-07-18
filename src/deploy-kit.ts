import { Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import { createHash } from 'node:crypto';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type {
  CloudFrontPriceClass,
  DeployKitContainerOptions,
  DeployKitDatabaseOptions,
  DeployKitProps,
} from './types';

const DEFAULT_STAGE = 'dev';
const ORIGIN_HEADER = 'X-DeployKit-Origin';

export class DeployKit extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly distribution?: cloudfront.Distribution;
  public readonly database?: rds.DatabaseInstance;
  public readonly databaseSecret?: secretsmanager.ISecret;
  public readonly logGroup: logs.LogGroup;
  public readonly url: string;

  public constructor(scope: Construct, id: string, props: DeployKitProps) {
    super(scope, id);

    validateContainerSource(props.container);
    validateNames(props);
    validateFargateSize(props.service?.cpu ?? 512, props.service?.memoryMiB ?? 1024);
    validateScaling(props);
    if (!props.vpc && (props.network?.natGateways ?? 1) < 1) {
      throw new Error('At least one NAT gateway is required for private Fargate tasks.');
    }

    const stage = props.stage ?? DEFAULT_STAGE;
    const production = ['prod', 'production'].includes(stage.toLowerCase());
    const resourcePrefix = `${props.name}-${stage}`;

    this.vpc =
      props.vpc ??
      new ec2.Vpc(this, 'Vpc', {
        ipAddresses: ec2.IpAddresses.cidr(props.network?.vpcCidr ?? '10.42.0.0/16'),
        maxAzs: props.network?.maxAzs ?? 2,
        natGateways: props.network?.natGateways ?? 1,
        restrictDefaultSecurityGroup: true,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: 'Public',
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            cidrMask: 24,
            name: 'Application',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          {
            cidrMask: 28,
            name: 'Database',
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
        ],
      });

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: resourcePrefix,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
      enableFargateCapacityProviders: true,
      vpc: this.vpc,
    });

    const databaseResources = this.createDatabase(props.database ?? {}, resourcePrefix, production);
    this.database = databaseResources.database;
    this.databaseSecret = databaseResources.secret;

    this.logGroup = new logs.LogGroup(this, 'ApplicationLogs', {
      logGroupName: `/deploykit/${resourcePrefix}/application`,
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      retention: production ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: props.service?.cpu ?? 512,
      memoryLimitMiB: props.service?.memoryMiB ?? 1024,
      runtimePlatform: {
        cpuArchitecture:
          props.container.architecture === 'ARM64'
            ? ecs.CpuArchitecture.ARM64
            : ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const environment: Record<string, string> = {
      ...props.container.environment,
      NODE_ENV: production ? 'production' : 'development',
      PORT: String(props.container.port ?? 3000),
    };
    const secrets = this.existingContainerSecrets(props.container);

    if (this.database && this.databaseSecret) {
      environment.DB_HOST = this.database.dbInstanceEndpointAddress;
      environment.DB_PORT = this.database.dbInstanceEndpointPort;
      environment.DB_NAME = props.database?.name ?? 'app';
      environment.DB_ENGINE = props.database?.engine ?? 'postgres';
      secrets.DB_USER = ecs.Secret.fromSecretsManager(this.databaseSecret, 'username');
      secrets.DB_PASSWORD = ecs.Secret.fromSecretsManager(this.databaseSecret, 'password');
      environment.DB_SECRET_ARN = this.databaseSecret.secretArn;
    }

    const container = taskDefinition.addContainer('Application', {
      command: props.container.command ? [...props.container.command] : undefined,
      environment,
      image: containerImage(props.container),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: 'app',
      }),
      secrets,
    });
    const containerPort = props.container.port ?? 3000;
    container.addPortMappings({
      appProtocol: ecs.AppProtocol.http,
      containerPort,
      name: 'http',
      protocol: ecs.Protocol.TCP,
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      allowAllOutbound: true,
      description: 'Traffic for DeployKit ECS tasks',
      vpc: this.vpc,
    });
    this.service = new ecs.FargateService(this, 'Service', {
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      cluster: this.cluster,
      desiredCount: props.service?.desiredCount ?? 2,
      enableECSManagedTags: true,
      enableExecuteCommand: props.service?.enableExecuteCommand ?? false,
      healthCheckGracePeriod: Duration.seconds(props.service?.healthCheckGracePeriodSeconds ?? 60),
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      securityGroups: [serviceSecurityGroup],
      taskDefinition,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    if (this.database) {
      this.database.connections.allowDefaultPortFrom(
        this.service,
        'Allow application tasks to reach the database',
      );
    }

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: props.service?.minCapacity ?? 2,
      maxCapacity: props.service?.maxCapacity ?? 6,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: props.service?.cpuTargetUtilization ?? 60,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60),
    });
    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: props.service?.memoryTargetUtilization ?? 70,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60),
    });

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      allowAllOutbound: false,
      description: 'CloudFront origin traffic for the DeployKit load balancer',
      vpc: this.vpc,
    });
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      deletionProtection: production,
      internetFacing: true,
      securityGroup: loadBalancerSecurityGroup,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    this.service.connections.allowFrom(
      this.loadBalancer,
      ec2.Port.tcp(containerPort),
      'Allow load balancer health checks and requests',
    );

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        healthyHttpCodes: '200-399',
        interval: Duration.seconds(30),
        path: props.container.healthCheckPath ?? '/health',
        timeout: Duration.seconds(5),
      },
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [this.service],
      vpc: this.vpc,
    });

    if (props.cdn?.enabled === false) {
      loadBalancerSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        'Public HTTP when CloudFront is disabled',
      );
      this.loadBalancer.addListener('HttpListener', {
        defaultAction: elbv2.ListenerAction.forward([targetGroup]),
        open: false,
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
      });
      this.url = `http://${this.loadBalancer.loadBalancerDnsName}`;
    } else {
      this.allowCloudFrontOriginTraffic(loadBalancerSecurityGroup);
      const originSecret = new secretsmanager.Secret(this, 'CloudFrontOriginSecret', {
        description: 'Verifies that application requests came through CloudFront',
        generateSecretString: {
          excludePunctuation: true,
          includeSpace: false,
          passwordLength: 48,
        },
      });
      const originSecretValue = originSecret.secretValue.unsafeUnwrap();
      const listener = this.loadBalancer.addListener('HttpListener', {
        defaultAction: elbv2.ListenerAction.fixedResponse(403, {
          contentType: 'text/plain',
          messageBody: 'Access denied',
        }),
        open: false,
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
      });
      listener.addAction('CloudFrontOnly', {
        action: elbv2.ListenerAction.forward([targetGroup]),
        conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_HEADER, [originSecretValue])],
        priority: 1,
      });

      this.distribution = new cloudfront.Distribution(this, 'Distribution', {
        comment: `${resourcePrefix} application`,
        defaultBehavior: {
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy:
            props.cdn?.cache === true
              ? cloudfront.CachePolicy.CACHING_OPTIMIZED
              : cloudfront.CachePolicy.CACHING_DISABLED,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          origin: new origins.LoadBalancerV2Origin(this.loadBalancer, {
            customHeaders: { [ORIGIN_HEADER]: originSecretValue },
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        enabled: true,
        httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
        priceClass: priceClass(props.cdn?.priceClass ?? '100'),
      });
      this.url = `https://${this.distribution.distributionDomainName}`;
    }

    Tags.of(this).add('deploykit:name', props.name);
    Tags.of(this).add('deploykit:stage', stage);
    Tags.of(this).add('deploykit:managed', 'true');
  }

  private createDatabase(
    options: DeployKitDatabaseOptions,
    resourcePrefix: string,
    production: boolean,
  ): { database?: rds.DatabaseInstance; secret?: secretsmanager.ISecret } {
    if (options.enabled === false) {
      return {};
    }

    const engine =
      options.engine === 'mysql'
        ? rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_4_6 })
        : rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17_6 });
    const removalPolicy = production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      allowAllOutbound: false,
      description: 'Inbound database traffic from DeployKit application tasks',
      vpc: this.vpc,
    });
    const database = new rds.DatabaseInstance(this, 'Database', {
      allocatedStorage: options.allocatedStorageGiB ?? 20,
      allowMajorVersionUpgrade: false,
      autoMinorVersionUpgrade: true,
      backupRetention: Duration.days(options.backupRetentionDays ?? (production ? 7 : 1)),
      cloudwatchLogsExports: options.engine === 'mysql' ? ['error', 'slowquery'] : ['postgresql'],
      credentials: rds.Credentials.fromGeneratedSecret(options.username ?? 'deploykit', {
        secretName: `${resourcePrefix}/database`,
      }),
      databaseName: options.name ?? 'app',
      deleteAutomatedBackups: !production,
      deletionProtection: options.deletionProtection ?? production,
      engine,
      instanceIdentifier: resourcePrefix,
      instanceType: new ec2.InstanceType(options.instanceType ?? 't4g.micro'),
      maxAllocatedStorage: options.maxAllocatedStorageGiB ?? 100,
      multiAz: options.multiAz ?? production,
      publiclyAccessible: false,
      removalPolicy,
      securityGroups: [databaseSecurityGroup],
      storageEncrypted: true,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });
    database.secret?.applyRemovalPolicy(removalPolicy);

    return { database, secret: database.secret ?? undefined };
  }

  private existingContainerSecrets(
    container: DeployKitContainerOptions,
  ): Record<string, ecs.Secret> {
    const values: Record<string, ecs.Secret> = {};
    for (const [environmentName, definition] of Object.entries(container.secrets ?? {})) {
      const secret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        `ImportedSecret${stableId(environmentName)}`,
        definition.secretArn,
      );
      values[environmentName] = ecs.Secret.fromSecretsManager(secret, definition.jsonField);
    }
    return values;
  }

  private allowCloudFrontOriginTraffic(securityGroup: ec2.SecurityGroup): void {
    const lookup = new customResources.AwsCustomResource(this, 'CloudFrontPrefixListLookup', {
      installLatestAwsSdk: false,
      onUpdate: {
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [
            {
              Name: 'prefix-list-name',
              Values: ['com.amazonaws.global.cloudfront.origin-facing'],
            },
          ],
        },
        physicalResourceId: customResources.PhysicalResourceId.of(
          `cloudfront-origin-prefix-list-${Stack.of(this).region}`,
        ),
        service: 'EC2',
      },
      policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: customResources.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    new ec2.CfnSecurityGroupIngress(this, 'CloudFrontIngress', {
      description: 'Allow HTTP only from the CloudFront origin-facing managed prefix list',
      fromPort: 80,
      groupId: securityGroup.securityGroupId,
      ipProtocol: 'tcp',
      sourcePrefixListId: lookup.getResponseField('PrefixLists.0.PrefixListId'),
      toPort: 80,
    });
  }
}

function containerImage(options: DeployKitContainerOptions): ecs.ContainerImage {
  if (options.directory) {
    return ecs.ContainerImage.fromAsset(options.directory, {
      buildArgs: options.buildArgs ? { ...options.buildArgs } : undefined,
      file: options.dockerfile,
      platform:
        options.architecture === 'ARM64'
          ? ecrAssets.Platform.LINUX_ARM64
          : ecrAssets.Platform.LINUX_AMD64,
    });
  }
  return ecs.ContainerImage.fromRegistry(options.image as string);
}

function priceClass(value: CloudFrontPriceClass): cloudfront.PriceClass {
  if (value === 'all') return cloudfront.PriceClass.PRICE_CLASS_ALL;
  if (value === '200') return cloudfront.PriceClass.PRICE_CLASS_200;
  return cloudfront.PriceClass.PRICE_CLASS_100;
}

function stableId(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9]/g, '').slice(0, 48) || 'Value';
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${readable}${hash}`;
}

function validateContainerSource(options: DeployKitContainerOptions): void {
  if (Boolean(options.directory) === Boolean(options.image)) {
    throw new Error('Set exactly one of container.directory or container.image.');
  }
}

function validateNames(props: DeployKitProps): void {
  if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(props.name)) {
    throw new Error('name must use 3-40 lowercase letters, numbers, or hyphens.');
  }
  if (props.stage && !/^[a-z][a-z0-9-]{0,19}$/.test(props.stage)) {
    throw new Error('stage must use 1-20 lowercase letters, numbers, or hyphens.');
  }
  for (const name of [
    ...Object.keys(props.container.environment ?? {}),
    ...Object.keys(props.container.secrets ?? {}),
  ]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid container environment variable name: ${name}`);
    }
  }
}

function validateFargateSize(cpu: number, memoryMiB: number): void {
  const validMemory: Record<number, readonly number[]> = {
    256: [512, 1024, 2048],
    512: [1024, 2048, 3072, 4096],
    1024: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
    2048: Array.from({ length: 13 }, (_, index) => 4096 + index * 1024),
    4096: Array.from({ length: 23 }, (_, index) => 8192 + index * 1024),
  };
  if (!validMemory[cpu]?.includes(memoryMiB)) {
    throw new Error(`Invalid Fargate size: ${cpu} CPU units with ${memoryMiB} MiB memory.`);
  }
}

function validateScaling(props: DeployKitProps): void {
  const desired = props.service?.desiredCount ?? 2;
  const minimum = props.service?.minCapacity ?? 2;
  const maximum = props.service?.maxCapacity ?? 6;
  if (minimum > desired || desired > maximum) {
    throw new Error('Expected minCapacity <= desiredCount <= maxCapacity.');
  }
}
