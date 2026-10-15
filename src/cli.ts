import { access, readFile } from 'node:fs/promises';
import process from 'node:process';
import { basename } from 'node:path';
import { z } from 'zod';
import { buildTestReport, parseTestFramework, readTestReport } from './reportBuilder';
import { readJiraPublishConfigFromEnv } from './jiraPublisher';
import { startTestReporterServer } from './server';
import { type TestFramework } from './testReportSchemas';

interface ParsedCliArgs {
  command: string | undefined;
  values: Map<string, string>;
  flags: Set<string>;
}

interface TestInput {
  framework: TestFramework;
  inputPath: string;
}

const packageNameSchema = z.object({ name: z.string().trim().min(1) });

type TestReporterEnvName
  = | 'TEST_REPORTER_ENDPOINT'
    | 'TEST_REPORTER_FRAMEWORK'
    | 'TEST_REPORTER_HOST'
    | 'TEST_REPORTER_INPUT'
    | 'TEST_REPORTER_INGEST_TOKEN'
    | 'TEST_REPORTER_OUTPUT'
    | 'TEST_REPORTER_PORT'
    | 'TEST_REPORTER_TOKEN';

async function main(): Promise<void> {
  const parsedArgs = parseCliArgs(process.argv.slice(2));

  if (!parsedArgs.command || parsedArgs.command === 'help') {
    printHelp();
    return;
  }

  if (parsedArgs.command === 'run') {
    await handleRun(parsedArgs);
    return;
  }

  if (parsedArgs.command === 'serve') {
    await handleServe(parsedArgs);
    return;
  }

  throw new Error(`Unknown command: ${parsedArgs.command}`);
}

function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const command = args[0];
  let index = 1;

  while (index < args.length) {
    const arg = args[index];

    if (!arg?.startsWith('--')) {
      index += 1;
      continue;
    }

    const option = arg.slice(2);
    const inlineSeparatorIndex = option.indexOf('=');

    if (inlineSeparatorIndex >= 0) {
      values.set(option.slice(0, inlineSeparatorIndex), option.slice(inlineSeparatorIndex + 1));
      index += 1;
      continue;
    }

    const nextArg = args[index + 1];

    if (nextArg && !nextArg.startsWith('--')) {
      values.set(option, nextArg);
      index += 2;
      continue;
    }

    flags.add(option);
    index += 1;
  }

  return {
    command,
    values,
    flags,
  };
}

async function handleRun(parsedArgs: ParsedCliArgs): Promise<void> {
  const endpoint = parsedArgs.values.get('endpoint') ?? readTestReporterEnv('TEST_REPORTER_ENDPOINT');

  if (!endpoint) {
    throw new Error('Missing central reporter endpoint. Pass --endpoint or set TEST_REPORTER_ENDPOINT.');
  }

  const testInput = await findTestInput(parsedArgs);

  if (!testInput || !await fileExists(testInput.inputPath)) {
    if (parsedArgs.flags.has('skip-if-missing')) {
      console.log('No JUnit XML found; skipping test reporting.');
      return;
    }

    throw new Error('No JUnit XML found. Pass --input or configure TEST_REPORTER_INPUT.');
  }

  const reportPath = await buildReport(parsedArgs, testInput);
  await submitReport(reportPath, endpoint, parsedArgs.values.get('token') ?? readTestReporterEnv('TEST_REPORTER_TOKEN'));
}

async function buildReport(parsedArgs: ParsedCliArgs, testInput: TestInput): Promise<string> {
  const { framework, inputPath } = testInput;
  const outputPath = parsedArgs.values.get('output')
    ?? readTestReporterEnv('TEST_REPORTER_OUTPUT')
    ?? `.test-reporter/${framework}-report.json`;
  const projectName = parsedArgs.values.get('project-name') ?? await readProjectName();
  const report = await buildTestReport({
    framework,
    inputPath,
    outputPath,
    projectName,
    includeUntagged: parsedArgs.flags.has('include-untagged'),
    branchName: parsedArgs.values.get('branch-name'),
    gitUrl: parsedArgs.values.get('git-url'),
    commitSha: parsedArgs.values.get('commit-sha'),
    pipelineUrl: parsedArgs.values.get('pipeline-url'),
    reportUrl: parsedArgs.values.get('report-url'),
    sourceRoot: parsedArgs.values.get('source-root') ?? getDefaultSourceRoot(framework),
  });

  console.log(`Wrote ${outputPath} with ${report.tests.length} visible tests.`);
  return outputPath;
}

async function submitReport(reportPath: string, endpoint: string, token: string | undefined): Promise<void> {
  const report = await readTestReport(reportPath);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: createSubmitHeaders(token),
    body: JSON.stringify(report),
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Submit failed with HTTP ${response.status}: ${responseText}`);
  }

  console.log(responseText);
}

async function findTestInput(parsedArgs: ParsedCliArgs): Promise<TestInput | undefined> {
  const configuredInput = parsedArgs.values.get('input') ?? readTestReporterEnv('TEST_REPORTER_INPUT');
  const configuredFramework = parsedArgs.values.get('framework') ?? readTestReporterEnv('TEST_REPORTER_FRAMEWORK');

  if (configuredInput) {
    return {
      framework: configuredFramework ? readFramework(configuredFramework) : 'generic',
      inputPath: configuredInput,
    };
  }

  if (configuredFramework) {
    return {
      framework: readFramework(configuredFramework),
      inputPath: getDefaultJunitPath(readFramework(configuredFramework)),
    };
  }

  const candidates: readonly TestInput[] = [
    { framework: 'playwright', inputPath: '.playwright/junit.xml' },
    { framework: 'vitest', inputPath: '.test-reporter/vitest-junit.xml' },
    { framework: 'phpunit', inputPath: '.test-reporter/phpunit-junit.xml' },
    { framework: 'generic', inputPath: '.test-reporter/junit.xml' },
    { framework: 'generic', inputPath: 'junit.xml' },
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate.inputPath)) {
      return candidate;
    }
  }

  return undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function handleServe(parsedArgs: ParsedCliArgs): Promise<void> {
  const host = parsedArgs.values.get('host') ?? readTestReporterEnv('TEST_REPORTER_HOST') ?? '127.0.0.1';
  const port = parsePort(parsedArgs.values.get('port') ?? readTestReporterEnv('TEST_REPORTER_PORT') ?? '3099');
  const ingestToken = parsedArgs.values.get('ingest-token') ?? readTestReporterEnv('TEST_REPORTER_INGEST_TOKEN');
  const jiraConfig = readJiraPublishConfigFromEnv();

  await startTestReporterServer({
    host,
    port,
    ingestToken,
    jiraConfig,
  });

  console.log(`Test reporter server listening on http://${host}:${port}`);
}

function readFramework(framework: string): TestFramework {
  return parseTestFramework(framework);
}

function getDefaultJunitPath(framework: TestFramework): string {
  if (framework === 'playwright') {
    return '.playwright/junit.xml';
  }

  if (framework === 'vitest') {
    return '.test-reporter/vitest-junit.xml';
  }

  if (framework === 'phpunit') {
    return '.test-reporter/phpunit-junit.xml';
  }

  return '.test-reporter/junit.xml';
}

function getDefaultSourceRoot(framework: TestFramework): string | undefined {
  if (framework === 'playwright') {
    return 'src';
  }

  return undefined;
}

async function readProjectName(): Promise<string> {
  const configuredName = readFirstEnv(['TEST_REPORTER_PROJECT_NAME', 'CI_PROJECT_PATH', 'BITBUCKET_REPO_FULL_NAME']);
  if (configuredName) {
    return configuredName;
  }

  try {
    const packageJson = await readFile('package.json', 'utf8');
    const packageData: unknown = JSON.parse(packageJson);
    return packageNameSchema.parse(packageData).name;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return basename(process.cwd());
    }
    throw error;
  }
}

function readTestReporterEnv(name: TestReporterEnvName): string | undefined {
  return readFirstEnv([name]);
}

function readFirstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

function createSubmitHeaders(token: string | undefined): Headers {
  const headers = new Headers({
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  });

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return headers;
}

function parsePort(port: string): number {
  const parsedPort = Number.parseInt(port, 10);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }

  return parsedPort;
}

function printHelp(): void {
  console.log(`Usage:
  test-reporter run [--framework playwright] [--input .playwright/junit.xml] [--skip-if-missing]
  test-reporter serve --port 3099

Frameworks: playwright, vitest, phpunit, generic

Environment:
  TEST_REPORTER_PROJECT_NAME   project identity (otherwise CI project, package name, or directory name)
  TEST_REPORTER_FRAMEWORK      optional framework override for run
  TEST_REPORTER_INPUT          optional JUnit XML path override for run
  TEST_REPORTER_OUTPUT         optional generated JSON path
  TEST_REPORTER_ENDPOINT       POST endpoint for submit
  TEST_REPORTER_TOKEN          optional bearer token for submit
  TEST_REPORTER_HOST           server bind host, defaults to 127.0.0.1
  TEST_REPORTER_INGEST_TOKEN   bearer token for exposed or live-publishing servers
  TEST_REPORTER_BRANCH_PATTERN optional regex for branches that publish to Jira
  JIRA_BASE_URL                  e.g. https://example.atlassian.net
  JIRA_EMAIL                     Jira user email for basic auth
  JIRA_API_TOKEN                 Jira API token for basic auth
  JIRA_BEARER_TOKEN              optional bearer auth alternative
  JIRA_DRY_RUN                   true/false, defaults to true if Jira config is incomplete`);
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }

  process.exitCode = 1;
});
