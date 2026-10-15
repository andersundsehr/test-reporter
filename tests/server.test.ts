import { describe, expect, it } from 'vitest';
import { startTestReporterServer, validateTestReporterServerOptions, type TestReporterServerOptions } from '../src/server';
import type { TestReport } from '../src/testReportSchemas';

describe('test reporter server', () => {
  it('allows localhost dry-run mode without an ingest token', () => {
    expect(() => validateTestReporterServerOptions(createOptions())).not.toThrow();
  });

  it('requires an ingest token when Jira publishing is enabled', () => {
    expect(() => validateTestReporterServerOptions(createOptions({
      jiraConfig: {
        apiVersion: '3',
        dryRun: false,
      },
    }))).toThrowError('TEST_REPORTER_INGEST_TOKEN is required when Jira publishing is enabled.');
  });

  it('requires an ingest token when binding to a wildcard host', () => {
    expect(() => validateTestReporterServerOptions(createOptions({
      host: '0.0.0.0',
    }))).toThrowError('TEST_REPORTER_INGEST_TOKEN is required when binding the server to a wildcard host.');
  });

  it('allows wildcard binding when an ingest token is configured', () => {
    expect(() => validateTestReporterServerOptions(createOptions({
      host: '0.0.0.0',
      ingestToken: 'secret',
    }))).not.toThrow();
  });

  it('accepts and publishes a report without persisting it', async () => {
    const server = await startTestReporterServer(createOptions({ port: 0 }));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP server address.');
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createReport()),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ accepted: true });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }));
    }
  });

  it('returns an error when Jira publishing fails', async () => {
    const server = await startTestReporterServer(createOptions({
      port: 0,
      ingestToken: 'secret',
      jiraConfig: {
        apiVersion: '3',
        dryRun: false,
      },
    }));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP server address.');
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/reports`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createReport()),
      });

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ accepted: false });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }));
    }
  });
});

function createOptions(overrides: Partial<TestReporterServerOptions> = {}): TestReporterServerOptions {
  return {
    host: '127.0.0.1',
    port: 3099,
    jiraConfig: {
      apiVersion: '3',
      dryRun: true,
    },
    ...overrides,
  };
}

function createReport(): TestReport {
  return {
    schemaVersion: 1,
    projectName: 'example/project',
    generatedAt: '2026-10-15T08:00:00.000Z',
    sourceReports: [
      {
        framework: 'generic',
        format: 'junit',
        path: 'junit.xml',
      },
    ],
    tests: [
      {
        framework: 'generic',
        name: 'reports a result',
        status: 'passed',
        ticketKeys: ['AUS-123'],
      },
    ],
  };
}
