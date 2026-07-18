# DeployKit

One-command AWS deployments for containerized applications. DeployKit is a TypeScript AWS CDK package and CLI that builds a local Docker image and provisions CloudFront, an Application Load Balancer, ECS Fargate, and RDS with secure network boundaries.

```bash
npm run deploy
```

That command compiles the project, checks the CDK bootstrap stack, builds and publishes the container asset, and deploys the complete CloudFormation stack.

## What it creates

- A VPC spanning two or three Availability Zones
- Public subnets for the ALB, private subnets for Fargate, and isolated subnets for RDS
- An ECS cluster, Fargate task definition, rolling service, deployment rollback, and CPU/memory autoscaling
- PostgreSQL or MySQL RDS with encrypted storage and generated Secrets Manager credentials
- A CloudFront distribution with HTTPS redirects and caching disabled by default
- An ALB restricted to the CloudFront origin-facing prefix list and a generated origin verification header
- CloudWatch application logs, health checks, outputs, and consistent resource tags

See the [architecture](docs/architecture.md) for the request path and trust boundaries.

## Quick start

You need Node.js 20 or newer, Docker, AWS credentials, and permission to deploy CloudFormation, IAM, VPC, ECS, RDS, CloudFront, Lambda, and Secrets Manager resources.

```bash
git clone https://github.com/Saithej2k/deploykit.git
cd deploykit
npm install
npm run doctor
npm run deploy
```

The repository includes a dependency-free Node.js sample container, so the default `deploykit.config.json` can deploy immediately. CDK displays security-sensitive changes for approval. When deployment finishes, open the `ApplicationUrl` stack output.

To remove a development stack:

```bash
npm run destroy
```

AWS resources incur charges while they exist. Read the [cost notes](docs/costs.md) before deploying. Production database state is retained by design.

## Configuration

DeployKit reads `deploykit.config.json` by default. Start with the checked-in example or copy `deploykit.config.example.json`.

```json
{
  "name": "orders-api",
  "stage": "dev",
  "region": "us-east-1",
  "container": {
    "directory": "./app",
    "port": 3000,
    "healthCheckPath": "/health",
    "environment": {
      "LOG_LEVEL": "info"
    }
  },
  "service": {
    "cpu": 512,
    "memoryMiB": 1024,
    "desiredCount": 2,
    "minCapacity": 2,
    "maxCapacity": 6
  },
  "database": {
    "enabled": true,
    "engine": "postgres",
    "name": "orders",
    "instanceType": "t4g.micro"
  },
  "cdn": {
    "enabled": true,
    "cache": false
  }
}
```

### Container

Set exactly one image source:

- `directory`: a local Docker build context. CDK builds and publishes it during deployment.
- `image`: an existing registry reference, such as `public.ecr.aws/nginx/nginx:stable`.

The container receives `PORT`, `NODE_ENV`, and the configured environment values. When RDS is enabled it also receives `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_ENGINE`, `DB_USER`, `DB_PASSWORD`, and `DB_SECRET_ARN`. The username and password are ECS secret values and do not appear as plaintext in the task definition.

Existing Secrets Manager values can be injected without copying them into config:

```json
{
  "container": {
    "directory": "./app",
    "secrets": {
      "STRIPE_API_KEY": {
        "secretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:stripe",
        "jsonField": "apiKey"
      }
    }
  }
}
```

### Stages

`dev` is optimized for iteration: one RDS Availability Zone, one-day backups, and destroy policies. A stage named `prod` or `production` enables:

- CloudFormation termination protection
- RDS deletion protection and Multi-AZ
- Seven-day database backups
- Retain policies for the database, its credential secret, and application logs

These defaults protect state, but they do not replace backups, restore tests, alarms, or an incident response plan.

### CloudFront caching

Caching is off by default because caching personalized or authenticated responses can expose data between users. Set `cdn.cache` to `true` only when the application's cache headers and response model are safe for shared caching.

## Commands

| Command           | Purpose                                               |
| ----------------- | ----------------------------------------------------- |
| `npm run doctor`  | Validate Node.js, config, CDK, and the container path |
| `npm run synth`   | Synthesize the CloudFormation template locally        |
| `npm run diff`    | Compare local infrastructure with the deployed stack  |
| `npm run deploy`  | Bootstrap if needed and deploy the stack              |
| `npm run destroy` | Destroy the stack subject to retention policies       |
| `npm run check`   | Run format, lint, tests, build, and synth             |

Pass CDK options after `--`:

```bash
npm run deploy -- --profile production
npm run deploy -- --config deploykit.prod.json --require-approval never
npm run diff -- --context featureFlag=value
```

Use `--no-bootstrap` when your platform team manages the CDK bootstrap stack separately.

## Use as a CDK construct

DeployKit can also be composed inside an existing TypeScript CDK application.

```ts
import { App } from 'aws-cdk-lib';
import { DeployKitStack } from '@saithej2k/deploykit';

const app = new App();

new DeployKitStack(app, 'Orders', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  name: 'orders-api',
  stage: 'prod',
  container: {
    image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/orders:2026-07-18',
    port: 3000,
    healthCheckPath: '/health',
  },
  database: {
    engine: 'postgres',
    name: 'orders',
  },
});
```

`DeployKit` is exported separately when you want to place the resources inside your own stack or provide an existing VPC.

## Operational notes

- Fargate tasks need outbound access through the NAT gateway to pull images and reach external services.
- The default CloudFront origin connection is HTTP. The ALB is network-restricted to CloudFront and validates a generated secret header. Add an origin certificate and HTTPS listener if your policy requires encryption on that hop.
- ECS Exec is disabled by default. Enabling it also requires caller permissions and Session Manager support.
- The generated database credentials are master credentials. Applications with stricter separation should create a least-privilege database user during initialization.
- Custom domains, WAF rules, alarms, and database proxies are intentionally left for application-specific composition.

## Development

```bash
npm install
npm run check
```

CI runs the same checks on every pull request and push to `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT © 2026 Saithej
