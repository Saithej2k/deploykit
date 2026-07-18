# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository and include the affected version, a minimal reproduction, and the expected impact.

## Deployment security

DeployKit uses private application subnets, isolated database subnets, encrypted RDS storage, Secrets Manager credentials, CloudFront-only ALB listener rules, and the AWS-managed CloudFront origin-facing prefix list.

Before a production deployment:

- review the synthesized template with `npm run diff`;
- use a dedicated AWS account and least-privilege deployment role;
- set `stage` to `prod` to enable stack termination protection, RDS deletion protection, Multi-AZ, and retained state;
- rotate imported application secrets according to your organization's policy;
- enable application-level authentication and authorization. Infrastructure controls do not replace them.
