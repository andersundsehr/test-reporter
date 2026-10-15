// @vitest-environment node
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testReportSchema } from '../src/testReportSchemas';

const runFile = promisify(execFile);
let distributionDir: string;
let reportEndpoint: string;
let reportServer: Server;
const submittedReports: unknown[] = [];
const projectDirs: string[] = [];
const fixture = '<testsuites><testsuite name="checkout"><testcase name="adds ticket" classname="tests/checkout.php"><properties><property name="jira" value="AUS-123"/></properties></testcase></testsuite></testsuites>';

beforeAll(async () => {
  distributionDir = await mkdtemp(path.join(tmpdir(), 'test-reporter-distribution-'));
  await build({
    configFile: path.resolve('vite.config.ts'),
    build: { outDir: distributionDir },
    logLevel: 'silent',
  });
  await cp('install.sh', path.join(distributionDir, 'install.sh'));

  reportServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      submittedReports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(202);
      response.end('{"accepted":true}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    reportServer.once('error', reject);
    reportServer.listen(0, '127.0.0.1', resolve);
  });
  const address = reportServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address.');
  }
  reportEndpoint = `http://127.0.0.1:${address.port}/reports`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => reportServer.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  }));
  await Promise.all([distributionDir, ...projectDirs].map(directory => rm(directory, { recursive: true, force: true })));
});

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'test reporter consumer '));
  projectDirs.push(directory);
  await writeFile(path.join(directory, 'junit.xml'), fixture);
  return directory;
}

async function runReporter(
  directory: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
  installerPath = path.join(distributionDir, 'install.sh'),
): Promise<string> {
  const result = await runFile('bash', [
    '-euc',
    'source "$1"; shift; test-reporter "$@"',
    'reporter-test',
    installerPath,
    ...args,
  ], {
    cwd: directory,
    env: {
      ...process.env,
      CI_PROJECT_PATH: '',
      BITBUCKET_REPO_FULL_NAME: '',
      TEST_REPORTER_PROJECT_NAME: '',
      TEST_REPORTER_ENDPOINT: reportEndpoint,
      ...environment,
    },
  });
  return result.stdout;
}

async function readReport(directory: string) {
  const reportData: unknown = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  return testReportSchema.parse(reportData);
}

describe('standalone distribution', () => {
  it('downloads a hosted bundle and fails installation on HTTP errors', async () => {
    const directory = await createProject();
    const installerPath = path.join(directory, 'downloaded-install.sh');
    await cp(path.join(distributionDir, 'install.sh'), installerPath);
    const bundle = await readFile(path.join(distributionDir, 'test-reporter.cjs'));
    const server = createServer((request, response) => {
      if (request.url === '/v1/test-reporter.cjs') {
        response.end(bundle);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP server address.');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const output = await runReporter(directory, ['help'], { TEST_REPORTER_BASE_URL: `${baseUrl}/v1/` }, installerPath);
      expect(output).toContain('test-reporter run');
      await expect(runReporter(directory, ['help'], { TEST_REPORTER_BASE_URL: `${baseUrl}/missing` }, installerPath))
        .rejects.toMatchObject({ code: 1 });
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

  it('builds a report from a PHP project without dependencies or package.json', async () => {
    const directory = await createProject();
    await runReporter(directory, ['run', '--framework', 'phpunit', '--input', 'junit.xml', '--output', 'report.json']);
    const report = await readReport(directory);
    expect(report.projectName).toBe(path.basename(directory));
    expect(report.tests).toHaveLength(1);
    expect(report.tests[0]?.ticketKeys).toEqual(['AUS-123']);
  });

  it('runs the complete workflow with an auto-detected generic JUnit report', async () => {
    const directory = await createProject();
    const submittedReportIndex = submittedReports.length;
    const output = await runReporter(directory, ['run', '--output', 'report.json']);
    const report = await readReport(directory);

    expect(report.sourceReports[0]?.framework).toBe('generic');
    expect(testReportSchema.parse(submittedReports[submittedReportIndex])).toEqual(report);
    expect(output).toContain('"accepted":true');
  });

  it('requires a central endpoint instead of publishing directly to Jira', async () => {
    const directory = await createProject();

    await expect(runReporter(directory, ['run'], { TEST_REPORTER_ENDPOINT: '' })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Missing central reporter endpoint'),
    });
  });

  it('can skip reporting when no JUnit report exists', async () => {
    const directory = await createProject();
    await rm(path.join(directory, 'junit.xml'));

    const output = await runReporter(directory, ['run', '--skip-if-missing']);

    expect(output).toContain('No JUnit XML found; skipping test reporting.');
  });

  it('uses the CI project identity and allows an explicit override', async () => {
    const directory = await createProject();
    const args = ['run', '--framework', 'phpunit', '--input', 'junit.xml', '--output', 'report.json'];
    await runReporter(directory, args, { CI_PROJECT_PATH: 'group/php-project' });
    expect((await readReport(directory)).projectName).toBe('group/php-project');
    await runReporter(directory, [...args, '--project-name', 'Explicit project'], { CI_PROJECT_PATH: 'group/php-project' });
    expect((await readReport(directory)).projectName).toBe('Explicit project');
  });

  it('preserves package-name fallback for local Node projects', async () => {
    const directory = await createProject();
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'consumer-project' }));
    await runReporter(directory, ['run', '--input', 'junit.xml', '--output', 'report.json']);
    expect((await readReport(directory)).projectName).toBe('consumer-project');
  });

  it('exits non-zero when a report cannot be built', async () => {
    const directory = await createProject();
    await expect(runReporter(directory, ['run', '--input', 'missing.xml'])).rejects.toMatchObject({ code: 1 });
  });
});
