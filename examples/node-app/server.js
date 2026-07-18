const http = require('node:http');

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();

const server = http.createServer((request, response) => {
  const path = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;

  if (path === '/health') {
    return json(response, 200, { status: 'ok' });
  }

  if (path === '/') {
    return json(response, 200, {
      databaseConfigured: Boolean(process.env.DB_HOST && process.env.DB_SECRET_ARN),
      message: process.env.APP_NAME || 'Deployed with DeployKit',
      region: process.env.AWS_REGION || 'local',
      startedAt,
    });
  }

  return json(response, 404, { error: 'Not found' });
});

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`Server listening on ${port}\n`);
});

function shutdown(signal) {
  process.stdout.write(`${signal} received; shutting down\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
