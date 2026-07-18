import { App } from 'aws-cdk-lib';
import recommendedFeatureFlags from 'aws-cdk-lib/recommended-feature-flags.json';
import { configToProps, loadConfig, stackName } from './config';
import { DeployKitStack } from './deploy-kit-stack';

function main(): void {
  const loaded = loadConfig(process.env.DEPLOYKIT_CONFIG ?? 'deploykit.config.json');
  const { config } = loaded;
  const app = new App({ context: recommendedFeatureFlags });
  const account = config.account ?? process.env.CDK_DEFAULT_ACCOUNT;

  new DeployKitStack(app, stackName(config), {
    ...configToProps(config),
    env: {
      ...(account ? { account } : {}),
      region: config.region,
    },
    description: `${config.name} ${config.stage} infrastructure managed by DeployKit`,
    tags: config.tags,
    terminationProtection: ['prod', 'production'].includes(config.stage.toLowerCase()),
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`DeployKit: ${message}\n`);
  process.exitCode = 1;
}
