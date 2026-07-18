# Contributing

Thanks for helping improve DeployKit.

## Local setup

Use Node.js 22 and npm 10 or newer.

```bash
npm install
npm run check
```

`npm run check` runs formatting, linting, unit tests, TypeScript compilation, and a CDK synthesis of the example stack.

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Update the README or files in `docs/` when configuration or deployment behavior changes.
- Do not commit AWS credentials, `.env` files, `cdk.context.json`, or generated `cdk.out` assets.
- Use a conventional, imperative commit summary such as `Add Aurora database option`.
