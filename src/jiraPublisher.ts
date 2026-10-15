import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { z } from 'zod';
import type { TestStatus, TestCase, TestReport } from './testReportSchemas';

export type TicketAggregateStatus = 'green' | 'red' | 'grey';
export type JiraPublishAction = 'dry-run' | 'published' | 'skipped';

const publishedStatusSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['green', 'red', 'grey']),
});
const jiraStatusPropertySchema = z.object({ value: publishedStatusSchema });

class JiraRequestError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
  }
}

export interface JiraPublishConfig {
  apiVersion: '2' | '3';
  dryRun: boolean;
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  bearerToken?: string;
  branchPattern?: string;
}

export interface JiraPublishIssueResult {
  ticketKey: string;
  status: TicketAggregateStatus;
  action: JiraPublishAction;
  testCount: number;
  httpStatus?: number;
  error?: string;
  reason?: string;
}

export interface JiraPublishResult {
  issues: JiraPublishIssueResult[];
}

interface JiraTicketGroup {
  ticketKey: string;
  tests: TestCase[];
}

interface JiraEntityProperty {
  key: string;
  value: unknown;
}

interface JiraCommentPayload {
  body: string | AtlassianDocument;
  properties: JiraEntityProperty[];
}

interface AtlassianDocument {
  version: 1;
  type: 'doc';
  content: AtlassianParagraph[];
}

interface AtlassianParagraph {
  type: 'paragraph';
  content: AtlassianText[];
}

interface AtlassianText {
  type: 'text';
  text: string;
  marks?: AtlassianLinkMark[];
}

interface AtlassianLinkMark {
  type: 'link';
  attrs: {
    href: string;
  };
}

interface JiraCommentFragment {
  text: string;
  link?: string;
}

export function readJiraPublishConfigFromEnv(): JiraPublishConfig {
  const baseUrl = readEnv('JIRA_BASE_URL');
  const email = readEnv('JIRA_EMAIL');
  const apiToken = readEnv('JIRA_API_TOKEN');
  const bearerToken = readEnv('JIRA_BEARER_TOKEN');
  const requestedDryRun = readBooleanEnv('JIRA_DRY_RUN');
  const hasAuth = Boolean(bearerToken || (email && apiToken));

  return {
    apiVersion: readEnv('JIRA_API_VERSION') === '2' ? '2' : '3',
    dryRun: requestedDryRun ?? !(baseUrl && hasAuth),
    baseUrl,
    email,
    apiToken,
    bearerToken,
    branchPattern: readFirstEnv(['TEST_REPORTER_BRANCH_PATTERN', 'TEST_VISIBILITY_BRANCH_PATTERN']),
  };
}

export async function publishReportToJira(
  report: TestReport,
  config: JiraPublishConfig,
): Promise<JiraPublishResult> {
  const groups = groupTestsByTicket(report.tests);

  if (!shouldPublishBranch(report.branchName, config.branchPattern)) {
    return {
      issues: groups.map(group => ({
        ticketKey: group.ticketKey,
        status: getTicketAggregateStatus(group.tests),
        action: 'skipped',
        testCount: group.tests.length,
        reason: `Branch "${report.branchName ?? 'unknown'}" does not match publish pattern.`,
      })),
    };
  }

  const issues: JiraPublishIssueResult[] = [];

  for (const group of groups) {
    const status = getTicketAggregateStatus(group.tests);

    if (config.dryRun) {
      issues.push({
        ticketKey: group.ticketKey,
        status,
        action: 'dry-run',
        testCount: group.tests.length,
      });
      continue;
    }

    const publishResult = await publishIssueComment(report, group, status, config);
    issues.push(publishResult);
  }

  return {
    issues,
  };
}

export function hasJiraPublishErrors(result: JiraPublishResult): boolean {
  return result.issues.some(issue => Boolean(issue.error));
}

export function groupTestsByTicket(tests: readonly TestCase[]): JiraTicketGroup[] {
  const groupedTests = new Map<string, TestCase[]>();

  tests.forEach((testCase) => {
    testCase.ticketKeys.forEach((ticketKey) => {
      const testsForTicket = groupedTests.get(ticketKey) ?? [];
      testsForTicket.push(testCase);
      groupedTests.set(ticketKey, testsForTicket);
    });
  });

  return Array.from(groupedTests.entries())
    .map(([ticketKey, ticketTests]) => ({
      ticketKey,
      tests: ticketTests,
    }))
    .sort((left, right) => left.ticketKey.localeCompare(right.ticketKey));
}

export function getTicketAggregateStatus(tests: readonly TestCase[]): TicketAggregateStatus {
  if (tests.length === 0) {
    return 'grey';
  }

  if (tests.some(testCase => testCase.status === 'failed')) {
    return 'red';
  }

  if (tests.every(testCase => testCase.status === 'passed')) {
    return 'green';
  }

  return 'grey';
}

function shouldPublishBranch(branchName: string | undefined, branchPattern: string | undefined): boolean {
  if (!branchPattern) {
    return true;
  }

  if (!branchName) {
    return false;
  }

  return new RegExp(branchPattern, 'u').test(branchName);
}

async function publishIssueComment(
  report: TestReport,
  group: JiraTicketGroup,
  status: TicketAggregateStatus,
  config: JiraPublishConfig,
): Promise<JiraPublishIssueResult> {
  const authHeader = buildAuthorizationHeader(config);

  if (!config.baseUrl || !authHeader) {
    return {
      ticketKey: group.ticketKey,
      status,
      action: 'skipped',
      testCount: group.tests.length,
      error: 'Jira configuration is incomplete.',
    };
  }

  const headers = {
    'Accept': 'application/json',
    'Authorization': authHeader,
    'Content-Type': 'application/json',
  };
  const propertyUrl = buildJiraStatusPropertyUrl(config.baseUrl, config.apiVersion, report, group);
  let action: JiraPublishAction = 'skipped';

  try {
    const previousResponse = await fetch(propertyUrl, { headers });
    if (previousResponse.status !== 404) {
      await requireSuccessfulResponse(previousResponse, 'Reading the previous test status');
      const previousData: unknown = await previousResponse.json();
      const previous = jiraStatusPropertySchema.parse(previousData);
      if (previous.value.status === status) {
        return {
          ticketKey: group.ticketKey,
          status,
          action: 'skipped',
          testCount: group.tests.length,
          reason: 'Test status has not changed since the last comment.',
        };
      }
    }

    const commentLines = buildIssueCommentLines(report, group.ticketKey, group.tests, status);
    const payload = buildJiraCommentPayload(commentLines, report, group, config.apiVersion);
    const response = await fetch(buildJiraCommentUrl(config.baseUrl, config.apiVersion, group.ticketKey), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    await requireSuccessfulResponse(response, 'Publishing the test comment');
    action = 'published';

    // Save only after the comment succeeds, so failed publishing can be retried.
    const savedResponse = await fetch(propertyUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        status,
        generatedAt: report.generatedAt,
        projectName: report.projectName,
        branchName: report.branchName,
      }),
    });
    await requireSuccessfulResponse(savedResponse, 'Saving the published test status');

    return {
      ticketKey: group.ticketKey,
      status,
      action,
      testCount: group.tests.length,
      httpStatus: response.status,
    };
  } catch (error: unknown) {
    return {
      ticketKey: group.ticketKey,
      status,
      action,
      testCount: group.tests.length,
      httpStatus: error instanceof JiraRequestError ? error.httpStatus : undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function requireSuccessfulResponse(response: Response, operation: string): Promise<void> {
  if (!response.ok) {
    throw new JiraRequestError(`${operation} failed with HTTP ${response.status}: ${await response.text()}`, response.status);
  }
}

function buildJiraStatusPropertyUrl(
  baseUrl: string,
  apiVersion: '2' | '3',
  report: TestReport,
  group: JiraTicketGroup,
): string {
  const frameworks = [...new Set(group.tests.map(testCase => testCase.framework))].sort();
  const scope = JSON.stringify([report.projectName, report.branchName ?? null, frameworks]);
  const propertyKey = `jira-test-report-status-${createHash('sha256').update(scope).digest('hex')}`;
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`rest/api/${apiVersion}/issue/${encodeURIComponent(group.ticketKey)}/properties/${propertyKey}`, normalizedBaseUrl).toString();
}

function buildAuthorizationHeader(config: JiraPublishConfig): string | undefined {
  if (config.bearerToken) {
    return `Bearer ${config.bearerToken}`;
  }

  if (!config.email || !config.apiToken) {
    return undefined;
  }

  const token = Buffer.from(`${config.email}:${config.apiToken}`, 'utf8').toString('base64');

  return `Basic ${token}`;
}

function buildJiraCommentUrl(baseUrl: string, apiVersion: '2' | '3', ticketKey: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(`rest/api/${apiVersion}/issue/${encodeURIComponent(ticketKey)}/comment`, normalizedBaseUrl);

  return url.toString();
}

function buildJiraCommentPayload(
  commentLines: readonly JiraCommentFragment[][],
  report: TestReport,
  group: JiraTicketGroup,
  apiVersion: '2' | '3',
): JiraCommentPayload {
  return {
    body: apiVersion === '3' ? buildAdfDocument(commentLines) : buildJiraWikiText(commentLines),
    properties: [
      {
        key: 'jira-test-report',
        value: {
          schemaVersion: report.schemaVersion,
          projectName: report.projectName,
          branchName: report.branchName,
          commitSha: report.commitSha,
          generatedAt: report.generatedAt,
          ticketKey: group.ticketKey,
          testCount: group.tests.length,
        },
      },
    ],
  };
}

function buildAdfDocument(lines: readonly JiraCommentFragment[][]): AtlassianDocument {
  return {
    version: 1,
    type: 'doc',
    content: lines.map(line => ({
      type: 'paragraph',
      content: line.map(fragment => ({
        type: 'text',
        text: fragment.text,
        ...(fragment.link
          ? {
              marks: [
                {
                  type: 'link' as const,
                  attrs: {
                    href: fragment.link,
                  },
                },
              ],
            }
          : {}),
      })),
    })),
  };
}

function buildJiraWikiText(lines: readonly JiraCommentFragment[][]): string {
  return lines
    .map(line => line
      .map(fragment => fragment.link ? buildJiraWikiLink(fragment.text, fragment.link) : fragment.text)
      .join(''))
    .join('\n');
}

function buildJiraWikiLink(label: string, url: string): string {
  const encodedUrl = url.replace(/[\]|]/gu, character => encodeURIComponent(character));

  return `[${label}|${encodedUrl}]`;
}

function buildIssueCommentLines(
  report: TestReport,
  ticketKey: string,
  tests: readonly TestCase[],
  status: TicketAggregateStatus,
): JiraCommentFragment[][] {
  const lines: JiraCommentFragment[][] = [
    [{ text: `Automatische Tests für ${ticketKey}` }],
    [{ text: `Status: ${getAggregateStatusLabel(status)}` }],
    [{ text: `Projekt: ${report.projectName}` }],
    [{ text: `Branch: ${report.branchName ?? 'unbekannt'}` }],
    [{ text: `Commit: ${report.commitSha ?? 'unbekannt'}` }],
  ];

  if (report.pipelineUrl) {
    lines.push([
      { text: 'Pipeline: ' },
      { text: 'Pipeline öffnen', link: report.pipelineUrl },
    ]);
  }

  if (report.reportUrl) {
    lines.push([
      { text: 'Report: ' },
      { text: 'Playwright-Report öffnen', link: report.reportUrl },
    ]);
  }

  lines.push([]);
  lines.push([{ text: 'Tests:' }]);

  tests.forEach((testCase) => {
    const location = testCase.file ? ` (${testCase.file})` : '';
    const codeLink = testCase.codeUrl
      ? [
          { text: ' Code: ' },
          { text: 'Datei öffnen', link: testCase.codeUrl },
        ]
      : [];
    const message = testCase.message ? ` Hinweis: ${truncate(testCase.message, 180)}` : '';

    lines.push([
      { text: `- ${getTestStatusLabel(testCase.status)} ${testCase.name}${location}.` },
      ...codeLink,
      ...(message ? [{ text: message }] : []),
    ]);
  });

  return lines;
}

function getAggregateStatusLabel(status: TicketAggregateStatus): string {
  if (status === 'green') {
    return '🟢 Grün';
  }

  if (status === 'red') {
    return '🔴 Rot';
  }

  return '⚪ Grau';
}

function getTestStatusLabel(status: TestStatus): string {
  if (status === 'passed') {
    return '🟢 Grün';
  }

  if (status === 'failed') {
    return '🔴 Rot';
  }

  return '⚪ Grau';
}

function truncate(value: string, maxLength: number): string {
  const normalizedValue = value.replace(/\s+/gu, ' ').trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 1)}...`;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();

  return value || undefined;
}

function readFirstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = readEnv(name);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function readBooleanEnv(name: string): boolean | undefined {
  const value = readEnv(name)?.toLowerCase();

  if (!value) {
    return undefined;
  }

  if (['1', 'true', 'yes'].includes(value)) {
    return true;
  }

  if (['0', 'false', 'no'].includes(value)) {
    return false;
  }

  return undefined;
}
