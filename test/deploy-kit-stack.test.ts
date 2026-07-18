import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DeployKit } from '../src/deploy-kit';

function templateFor(stage = 'dev', overrides: Record<string, unknown> = {}): Template {
  const app = new App();
  const stack = new Stack(app, `Test-${stage}`);
  new DeployKit(stack, 'DeployKit', {
    name: 'orders-api',
    stage,
    container: {
      image: 'public.ecr.aws/nginx/nginx:stable',
      port: 8080,
      healthCheckPath: '/health',
    },
    ...overrides,
  });
  return Template.fromStack(stack);
}

describe('DeployKit', () => {
  it('creates the complete edge, compute, and data stack', () => {
    const template = templateFor();

    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);

    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBName: 'app',
      DeletionProtection: false,
      MultiAZ: false,
      PubliclyAccessible: false,
      StorageEncrypted: true,
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
      DesiredCount: 2,
      EnableExecuteCommand: false,
      LaunchType: 'FARGATE',
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
        HttpVersion: 'http2and3',
      }),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      Description: 'Allow HTTP only from the CloudFront origin-facing managed prefix list',
      FromPort: 80,
      IpProtocol: 'tcp',
      ToPort: 80,
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'CloudFront origin traffic for the DeployKit load balancer',
      SecurityGroupIngress: Match.absent(),
    });
  });

  it('protects state in production', () => {
    const template = templateFor('prod');
    const databases = template.findResources('AWS::RDS::DBInstance');
    const database = Object.values(databases)[0] as
      | {
          DeletionPolicy?: string;
          UpdateReplacePolicy?: string;
          Properties?: Record<string, unknown>;
        }
      | undefined;

    expect(database?.DeletionPolicy).toBe('Retain');
    expect(database?.UpdateReplacePolicy).toBe('Retain');
    expect(database?.Properties?.DeletionProtection).toBe(true);
    expect(database?.Properties?.MultiAZ).toBe(true);
  });

  it('supports stateless services without RDS', () => {
    const template = templateFor('dev', { database: { enabled: false } });

    template.resourceCountIs('AWS::RDS::DBInstance', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  it('can expose the ALB directly when CloudFront is disabled', () => {
    const template = templateFor('dev', { cdn: { enabled: false } });

    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'CloudFront origin traffic for the DeployKit load balancer',
      SecurityGroupIngress: Match.arrayWith([
        {
          CidrIp: '0.0.0.0/0',
          Description: 'Public HTTP when CloudFront is disabled',
          FromPort: 80,
          IpProtocol: 'tcp',
          ToPort: 80,
        },
      ]),
    });
  });

  it('rejects unsupported Fargate CPU and memory pairs', () => {
    const app = new App();
    const stack = new Stack(app, 'Invalid');

    expect(
      () =>
        new DeployKit(stack, 'DeployKit', {
          name: 'orders-api',
          container: { image: 'nginx:stable' },
          service: { cpu: 256, memoryMiB: 4096 },
        }),
    ).toThrow('Invalid Fargate size');
  });
});
