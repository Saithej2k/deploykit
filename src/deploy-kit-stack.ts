import { CfnOutput, Stack, type StackProps, Tags } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { DeployKit } from './deploy-kit';
import type { DeployKitProps } from './types';

export interface DeployKitStackProps extends StackProps, DeployKitProps {
  readonly tags?: Readonly<Record<string, string>>;
}

export class DeployKitStack extends Stack {
  public readonly deployKit: DeployKit;

  public constructor(scope: Construct, id: string, props: DeployKitStackProps) {
    super(scope, id, props);

    this.deployKit = new DeployKit(this, 'Infrastructure', props);
    for (const [key, value] of Object.entries(props.tags ?? {})) {
      Tags.of(this).add(key, value);
    }

    new CfnOutput(this, 'ApplicationUrl', {
      description: 'Public application URL',
      value: this.deployKit.url,
    });
    new CfnOutput(this, 'ClusterName', {
      value: this.deployKit.cluster.clusterName,
    });
    new CfnOutput(this, 'ServiceName', {
      value: this.deployKit.service.serviceName,
    });
    new CfnOutput(this, 'LoadBalancerDnsName', {
      description: 'Origin hostname; direct requests are denied when CloudFront is enabled',
      value: this.deployKit.loadBalancer.loadBalancerDnsName,
    });
    if (this.deployKit.databaseSecret) {
      new CfnOutput(this, 'DatabaseSecretArn', {
        description: 'Secrets Manager ARN containing the generated database credentials',
        value: this.deployKit.databaseSecret.secretArn,
      });
    }
  }
}
