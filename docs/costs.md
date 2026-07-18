# Cost notes

DeployKit creates billable AWS resources. The largest steady costs are normally the NAT gateway, Application Load Balancer, running Fargate tasks, RDS instance and storage, and CloudFront traffic. Secrets Manager, CloudWatch Logs, and enhanced Container Insights add smaller usage-based charges.

The default development configuration favors availability over the lowest possible price: two Fargate tasks, one NAT gateway, an ALB, CloudFront, and a `db.t4g.micro`-class RDS instance. Prices vary by region and traffic, so use the [AWS Pricing Calculator](https://calculator.aws/) before deployment.

To control cost:

- deploy development stacks only while they are in use;
- reduce `desiredCount` and `minCapacity` to `1` for disposable non-production environments;
- disable the database with `database.enabled: false` for stateless services;
- leave CloudFront caching disabled for dynamic/authenticated applications, and enable it only when responses are safely cacheable;
- run `npm run destroy` when finished, then verify retained resources and snapshots in the AWS console.

Production database resources are intentionally retained and deletion-protected. Removing them requires an explicit policy change and a separate deletion decision.
