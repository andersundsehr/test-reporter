import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  getTicketAggregateStatus,
  groupTestsByTicket,
  hasJiraPublishErrors,
  publishReportToJira,
  type JiraPublishResult,
  type JiraPublishConfig,
  type TicketAggregateStatus,
} from '../src/jiraPublisher';
import type { TestCase, TestReport } from '../src/testReportSchemas';

const jiraLinkMarkSchema = z.object({
  type: z.literal('link'),
  attrs: z.object({
    href: z.string(),
  }),
});

const jiraAdfPayloadSchema = z.object({
  body: z.object({
    content: z.array(z.object({
      content: z.array(z.object({
        type: z.literal('text'),
        text: z.string(),
        marks: z.array(jiraLinkMarkSchema).optional(),
      })),
    })),
  }),
});

const jiraWikiPayloadSchema = z.object({
  body: z.string(),
});

const fetchCallSchema = z.tuple([
  z.unknown(),
  z.object({
    body: z.string(),
  }),
]);

const liveConfig: JiraPublishConfig = {
  apiVersion: '3',
  dryRun: false,
  baseUrl: 'https://jira.example.com',
  bearerToken: 'token',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('jiraPublisher', () => {
  it('groups test cases by every tagged ticket', () => {
    const testCases: TestCase[] = [
      createTestCase('AUS-123 checkout', 'passed', ['AUS-123', 'AUS-124']),
      createTestCase('AUS-124 coupon', 'failed', ['AUS-124']),
      createTestCase('untagged', 'passed', []),
    ];

    expect(groupTestsByTicket(testCases)).toEqual([
      {
        ticketKey: 'AUS-123',
        tests: [testCases[0]],
      },
      {
        ticketKey: 'AUS-124',
        tests: [testCases[0], testCases[1]],
      },
    ]);
  });

  it('maps aggregate status to red, green or grey', () => {
    expect(getTicketAggregateStatus([
      createTestCase('AUS-123 checkout', 'passed', ['AUS-123']),
    ])).toBe('green');
    expect(getTicketAggregateStatus([
      createTestCase('AUS-123 checkout', 'passed', ['AUS-123']),
      createTestCase('AUS-123 coupon', 'failed', ['AUS-123']),
    ])).toBe('red');
    expect(getTicketAggregateStatus([
      createTestCase('AUS-123 checkout', 'skipped', ['AUS-123']),
    ])).toBe('grey');
  });

  it('does not treat branch pattern skips as publish errors', async () => {
    const result = await publishReportToJira(createReport(), {
      apiVersion: '3',
      dryRun: false,
      branchPattern: '^main$',
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      ticketKey: 'AUS-123',
      action: 'skipped',
      reason: 'Branch "feature/test" does not match publish pattern.',
    });
    expect(hasJiraPublishErrors(result)).toBe(false);
  });

  it('treats live Jira configuration failures as publish errors', async () => {
    const result = await publishReportToJira(createReport(), {
      apiVersion: '3',
      dryRun: false,
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      ticketKey: 'AUS-123',
      action: 'skipped',
      error: 'Jira configuration is incomplete.',
    });
    expect(hasJiraPublishErrors(result)).toBe(true);
  });

  it('detects publish errors without flagging informational skips', () => {
    const result: JiraPublishResult = {
      issues: [
        {
          ticketKey: 'AUS-123',
          status: 'green',
          action: 'skipped',
          testCount: 1,
          reason: 'Branch is intentionally ignored.',
        },
        {
          ticketKey: 'AUS-124',
          status: 'red',
          action: 'skipped',
          testCount: 1,
          error: 'HTTP 401',
        },
      ],
    };

    expect(hasJiraPublishErrors(result)).toBe(true);
  });

  it('publishes Jira Cloud comments with linked labels, emojis and umlauts', async () => {
    const fetchMock = createFreshPublishFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    try {
      const report: TestReport = {
        ...createReport(),
        pipelineUrl: 'https://gitlab.example.com/pipelines/123',
        reportUrl: 'https://reports.example.com/playwright',
        tests: [
          {
            ...createTestCase('AUS-123 checkout', 'failed', ['AUS-123']),
            codeUrl: 'https://gitlab.example.com/project/-/blob/main/src/cart.test.ts',
          },
          createTestCase('AUS-123 confirmation', 'passed', ['AUS-123']),
        ],
      };

      await publishReportToJira(report, {
        apiVersion: '3',
        dryRun: false,
        baseUrl: 'https://jira.example.com',
        email: 'automation@example.com',
        apiToken: 'token',
      });

      const request = fetchMock.mock.calls[1];
      const payload = jiraAdfPayloadSchema.parse(JSON.parse(readFetchRequestBody(request)));
      const fragments = payload.body.content.flatMap(paragraph => paragraph.content);

      expect(fragments.some(fragment => fragment.text === 'Automatische Tests für AUS-123')).toBe(true);
      expect(fragments.some(fragment => fragment.text === 'Status: 🔴 Rot')).toBe(true);
      expect(hasJiraLink(fragments, 'Pipeline öffnen', report.pipelineUrl)).toBe(true);
      expect(hasJiraLink(fragments, 'Playwright-Report öffnen', report.reportUrl)).toBe(true);
      expect(hasJiraLink(fragments, 'Datei öffnen', report.tests[0]?.codeUrl)).toBe(true);
      expect(fragments.some(fragment => fragment.text === '- 🔴 Rot AUS-123 checkout.')).toBe(true);
      expect(fragments.some(fragment => fragment.text === '- 🟢 Grün AUS-123 confirmation.')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('publishes labelled Jira wiki links for API v2', async () => {
    const fetchMock = createFreshPublishFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    try {
      const report: TestReport = {
        ...createReport(),
        pipelineUrl: 'https://gitlab.example.com/pipelines/123',
        reportUrl: 'https://reports.example.com/playwright',
        tests: [
          {
            ...createTestCase('AUS-123 checkout', 'passed', ['AUS-123']),
            codeUrl: 'https://gitlab.example.com/project/-/blob/main/src/cart.test.ts',
            message: 'Assertion failed',
          },
        ],
      };

      await publishReportToJira(report, {
        apiVersion: '2',
        dryRun: false,
        baseUrl: 'https://jira.example.com',
        email: 'automation@example.com',
        apiToken: 'token',
      });

      const request = fetchMock.mock.calls[1];
      const payload = jiraWikiPayloadSchema.parse(JSON.parse(readFetchRequestBody(request)));

      expect(payload.body).toContain('[Pipeline öffnen|https://gitlab.example.com/pipelines/123]');
      expect(payload.body).toContain('[Playwright-Report öffnen|https://reports.example.com/playwright]');
      expect(payload.body).toContain('[Datei öffnen|https://gitlab.example.com/project/-/blob/main/src/cart.test.ts]');
      expect(payload.body.indexOf('Datei öffnen')).toBeLessThan(payload.body.indexOf('Hinweis: Assertion failed'));

      const encodedReport = {
        ...report,
        reportUrl: 'https://reports.example.com/playwright?filter=a|b]',
      };
      fetchMock.mockClear();

      await publishReportToJira(encodedReport, {
        apiVersion: '2',
        dryRun: false,
        baseUrl: 'https://jira.example.com',
        email: 'automation@example.com',
        apiToken: 'token',
      });

      const encodedRequest = fetchMock.mock.calls[1];
      const encodedPayload = jiraWikiPayloadSchema.parse(JSON.parse(readFetchRequestBody(encodedRequest)));

      expect(encodedPayload.body).toContain('[Playwright-Report öffnen|https://reports.example.com/playwright?filter=a%7Cb%5D]');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('comments on the first run and saves the status in Jira after publishing', async () => {
    const fetchMock = createFreshPublishFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishReportToJira(createReport(), liveConfig);
    expect(result.issues[0]?.action).toBe('published');
    expect(fetchMock.mock.calls.map(call => call[1]?.method ?? 'GET')).toEqual(['GET', 'POST', 'PUT']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(fetchMock.mock.calls[2]?.[0]);
    expect(JSON.parse(readFetchRequestBody(fetchMock.mock.calls[2]))).toMatchObject({ status: 'green', schemaVersion: 1 });
  });

  it.each<[TestCase['status']]>([['passed'], ['failed'], ['skipped']])('skips unchanged %s results even with a new commit and pipeline', async (testStatus) => {
    const report = createReport();
    report.tests[0] = createTestCase('checkout', testStatus, ['AUS-123']);
    const status = getTicketAggregateStatus(report.tests);
    const fetchMock = createFreshPublishFetchMock().mockResolvedValueOnce(statusResponse(status));
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishReportToJira({ ...report, commitSha: 'abcdef123', pipelineUrl: 'https://gitlab.example.com/pipelines/456' }, liveConfig);
    expect(result.issues[0]).toMatchObject({ action: 'skipped', reason: 'Test status has not changed since the last comment.' });
    expect(hasJiraPublishErrors(result)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each<[TicketAggregateStatus, TestCase['status']]>([
    ['green', 'failed'],
    ['red', 'passed'],
    ['green', 'skipped'],
    ['grey', 'passed'],
  ])('comments when %s changes to %s', async (previousStatus, testStatus) => {
    const fetchMock = createFreshPublishFetchMock().mockResolvedValueOnce(statusResponse(previousStatus));
    vi.stubGlobal('fetch', fetchMock);
    const report = createReport();
    report.tests[0] = createTestCase('checkout', testStatus, ['AUS-123']);
    const result = await publishReportToJira(report, liveConfig);
    expect(result.issues[0]?.action).toBe('published');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the saved status separate for each project, branch, and test runner', async () => {
    const fetchMock = createFreshPublishFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const report = createReport();
    const reports: TestReport[] = [
      report,
      { ...report, projectName: 'another-project' },
      { ...report, branchName: 'main' },
      { ...report, tests: [{ ...createTestCase('checkout', 'passed', ['AUS-123']), framework: 'playwright' }] },
    ];
    for (const scopedReport of reports) {
      await publishReportToJira(scopedReport, liveConfig);
    }
    const propertyUrls = fetchMock.mock.calls.filter(call => !call[1]?.method).map(call => call[0]);
    expect(new Set(propertyUrls).size).toBe(4);
  });

  it('does not access Jira in dry-run mode', async () => {
    const fetchMock = createFreshPublishFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    await publishReportToJira(createReport(), { ...liveConfig, dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not comment or save status when reading the previous status fails', async () => {
    const fetchMock = createFreshPublishFetchMock().mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishReportToJira(createReport(), liveConfig);
    expect(result.issues[0]).toMatchObject({ action: 'skipped', httpStatus: 403 });
    expect(hasJiraPublishErrors(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite malformed saved status or publish a comment', async () => {
    const fetchMock = createFreshPublishFetchMock().mockResolvedValueOnce(Response.json({ value: { status: 'unexpected' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishReportToJira(createReport(), liveConfig);
    expect(hasJiraPublishErrors(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not save status after a comment fails', async () => {
    const fetchMock = createFreshPublishFetchMock()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishReportToJira(createReport(), liveConfig);
    expect(result.issues[0]).toMatchObject({ action: 'skipped', httpStatus: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a saved-status failure even when the comment was published', async () => {
    const fetchMock = createFreshPublishFetchMock()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 201 }))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishReportToJira(createReport(), liveConfig);
    expect(result.issues[0]).toMatchObject({ action: 'published', httpStatus: 403 });
    expect(hasJiraPublishErrors(result)).toBe(true);
  });

  it('reports network errors per ticket and continues with other tickets', async () => {
    const fetchMock = createFreshPublishFetchMock().mockRejectedValueOnce(new Error('Network unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    const report = createReport();
    report.tests.push(createTestCase('another ticket', 'passed', ['AUS-124']));
    const result = await publishReportToJira(report, liveConfig);
    expect(result.issues[0]).toMatchObject({ action: 'skipped', error: 'Network unavailable' });
    expect(result.issues[1]?.action).toBe('published');
  });
});

function createFreshPublishFetchMock() {
  return vi.fn((_url: unknown, options?: RequestInit): Promise<Response> => {
    if (options?.method === 'POST') {
      return Promise.resolve(new Response('{}', { status: 201 }));
    }
    if (options?.method === 'PUT') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

function statusResponse(status: string): Response {
  return Response.json({ value: { schemaVersion: 1, status } });
}

function hasJiraLink(
  fragments: z.infer<typeof jiraAdfPayloadSchema>['body']['content'][number]['content'],
  text: string,
  href: string | undefined,
): boolean {
  return fragments.some(fragment => (
    fragment.text === text
    && fragment.marks?.some(mark => mark.type === 'link' && mark.attrs.href === href)
  ));
}

function readFetchRequestBody(call: unknown): string {
  return fetchCallSchema.parse(call)[1].body;
}

function createTestCase(
  name: string,
  status: TestCase['status'],
  ticketKeys: string[],
): TestCase {
  return {
    framework: 'vitest',
    name,
    status,
    ticketKeys,
  };
}

function createReport(): TestReport {
  return {
    schemaVersion: 1,
    projectName: 'lms-components',
    branchName: 'feature/test',
    generatedAt: '2026-08-24T00:00:00.000Z',
    sourceReports: [
      {
        framework: 'vitest',
        format: 'junit',
        path: 'junit.xml',
      },
    ],
    tests: [
      createTestCase('AUS-123 checkout', 'passed', ['AUS-123']),
    ],
  };
}
