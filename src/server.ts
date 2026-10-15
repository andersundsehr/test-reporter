import { Buffer } from 'node:buffer';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hasJiraPublishErrors, publishReportToJira, type JiraPublishConfig } from './jiraPublisher';
import { testReportSchema } from './testReportSchemas';

const maxRequestBytes = 5_000_000;

export interface TestReporterServerOptions {
  host: string;
  port: number;
  ingestToken?: string;
  jiraConfig: JiraPublishConfig;
}

export async function startTestReporterServer(options: TestReporterServerOptions): Promise<Server> {
  validateTestReporterServerOptions(options);

  const server = createServer((request, response) => {
    void handleRequest(request, response, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });

  return server;
}

export function validateTestReporterServerOptions(options: TestReporterServerOptions): void {
  if (!options.jiraConfig.dryRun && !options.ingestToken) {
    throw new Error('TEST_REPORTER_INGEST_TOKEN is required when Jira publishing is enabled.');
  }

  if (isWildcardHost(options.host) && !options.ingestToken) {
    throw new Error('TEST_REPORTER_INGEST_TOKEN is required when binding the server to a wildcard host.');
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: TestReporterServerOptions,
): Promise<void> {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, {
        ok: true,
      });
      return;
    }

    if (request.method !== 'POST' || request.url !== '/reports') {
      sendJson(response, 404, {
        error: 'Not found.',
      });
      return;
    }

    if (!isAuthorized(request, options.ingestToken)) {
      sendJson(response, 401, {
        error: 'Unauthorized.',
      });
      return;
    }

    const body = await readRequestBody(request);
    const bodyData: unknown = JSON.parse(body);
    const report = testReportSchema.parse(bodyData);

    const jira = await publishReportToJira(report, options.jiraConfig);

    if (hasJiraPublishErrors(jira)) {
      sendJson(response, 502, {
        accepted: false,
        jira,
      });
      return;
    }

    sendJson(response, 202, {
      accepted: true,
      jira,
    });
  } catch (error) {
    sendJson(response, 400, {
      error: errorToMessage(error),
    });
  }
}

function isAuthorized(request: IncomingMessage, ingestToken: string | undefined): boolean {
  if (!ingestToken) {
    return true;
  }

  const authorization = readHeader(request.headers.authorization);
  return authorization === `Bearer ${ingestToken}`;
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function isWildcardHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();

  return normalizedHost === '0.0.0.0' || normalizedHost === '::' || normalizedHost === '[::]';
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    request.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;

      if (totalBytes > maxRequestBytes) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
  });
  response.end(JSON.stringify(body, undefined, 2));
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
