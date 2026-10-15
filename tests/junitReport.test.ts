import { describe, expect, it } from 'vitest';
import { parseJunitXml } from '../src/junitReport';

describe('parseJunitXml', () => {
  it('extracts property-tagged passed, failed and skipped test cases', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Checkout">
    <testcase classname="cart" name="adds an item" file="src/cart.test.ts" time="0.25">
      <properties>
        <property name="jira" value="AUS-123" />
      </properties>
    </testcase>
    <testcase classname="cart" name="rejects invalid coupon" file="src/coupon.test.ts" time="1.5">
      <properties>
        <property name="jira" value="AUS-123" />
      </properties>
      <failure message="Expected coupon to be rejected">Diff output</failure>
    </testcase>
    <testcase classname="cart" name="supports guest checkout" file="src/guest.test.ts">
      <properties>
        <property name="jira" value="AUS-124" />
      </properties>
      <skipped message="Depends on feature flag" />
    </testcase>
    <testcase classname="cart" name="untagged helper test" />
  </testsuite>
</testsuites>`;

    const testCases = parseJunitXml(xml, {
      framework: 'vitest',
      inputPath: 'junit.xml',
      includeUntagged: false,
      gitUrl: 'git@gitlab.example.com:group/project.git',
      commitSha: '1234567890abcdef',
    });

    expect(testCases).toHaveLength(3);
    expect(testCases[0]).toMatchObject({
      name: 'adds an item',
      status: 'passed',
      ticketKeys: ['AUS-123'],
      durationMs: 250,
      codeUrl: 'https://gitlab.example.com/group/project/-/blob/1234567890abcdef/src/cart.test.ts',
    });
    expect(testCases[1]).toMatchObject({
      status: 'failed',
      message: 'Expected coupon to be rejected\nDiff output',
    });
    expect(testCases[2]).toMatchObject({
      status: 'skipped',
      ticketKeys: ['AUS-124'],
    });
  });

  it('can include untagged test cases when requested', () => {
    const xml = `<testsuite name="Core">
  <testcase classname="core" name="works without a ticket" />
</testsuite>`;

    const testCases = parseJunitXml(xml, {
      framework: 'playwright',
      inputPath: 'junit.xml',
      includeUntagged: true,
    });

    expect(testCases).toHaveLength(1);
    expect(testCases[0]).toMatchObject({
      name: 'works without a ticket',
      ticketKeys: [],
    });
  });

  it('uses path-like classnames as source files with the configured source root', () => {
    const xml = `<testsuite name="histoire/utils/test-all-variants.spec.ts">
  <testcase classname="histoire/utils/test-all-variants.spec.ts" name="renders the story">
    <properties>
      <property name="jira" value="AUS-125" />
    </properties>
  </testcase>
</testsuite>`;

    const testCases = parseJunitXml(xml, {
      framework: 'playwright',
      inputPath: 'junit.xml',
      includeUntagged: false,
      gitUrl: 'git@gitlab.example.com:group/project.git',
      commitSha: '1234567890abcdef',
      sourceRoot: 'src',
    });

    expect(testCases).toHaveLength(1);
    expect(testCases[0]).toMatchObject({
      name: 'renders the story',
      file: 'src/histoire/utils/test-all-variants.spec.ts',
      codeUrl: 'https://gitlab.example.com/group/project/-/blob/1234567890abcdef/src/histoire/utils/test-all-variants.spec.ts',
      ticketKeys: ['AUS-125'],
    });
  });

  it('extracts ticket keys from Playwright testcase properties', () => {
    const xml = `<testsuite name="Checkout">
  <testcase classname="cart" name="adds an item">
    <properties>
      <property name="jira" value="LMSTICKET-2202" />
      <property name="issue" value="https://example.atlassian.net/browse/LMSTICKET-2203" />
    </properties>
  </testcase>
</testsuite>`;

    const testCases = parseJunitXml(xml, {
      framework: 'playwright',
      inputPath: 'junit.xml',
      includeUntagged: false,
    });

    expect(testCases).toHaveLength(1);
    expect(testCases[0]).toMatchObject({
      name: 'adds an item',
      ticketKeys: ['LMSTICKET-2202', 'LMSTICKET-2203'],
    });
  });

  it('does not extract ticket keys from failure output paths', () => {
    const xml = `<testsuite name="histoire/utils/test-all-variants.spec.ts">
  <testcase classname="histoire/utils/test-all-variants.spec.ts" name="LmsTicketListPage › 1 Ohne Gruppen">
    <failure message="test-all-variants.spec.ts:28:7 1 Ohne Gruppen">
      Expected: /project/.playwright/screenshots/LmsTicketListPage-1-Ohne-Gruppen-1.png
      Received: /project/.playwright/test-results/cketListPage-1-Ohne-Gruppen-default/LmsTicketListPage-1-actual.png
      Diff: /project/.playwright/test-results/LmsTicketListPage-1-diff.png
    </failure>
  </testcase>
</testsuite>`;

    const testCases = parseJunitXml(xml, {
      framework: 'playwright',
      inputPath: 'junit.xml',
      includeUntagged: false,
      sourceRoot: 'src',
    });

    expect(testCases).toHaveLength(0);
  });

  it('does not extract ticket-like text from suite or test names', () => {
    const xml = `<testsuite name="[LMSTICKET-2204] Checkout">
  <testcase classname="cart" name="LMSTICKET-2201 maxOrderQuantity of product with groups" />
  <testcase classname="cart" name="[LMSTICKET-2202] bracketed title is ignored" />
  <testcase classname="cart" name="Closed-1 flow stays hidden" />
</testsuite>`;

    const testCases = parseJunitXml(xml, {
      framework: 'playwright',
      inputPath: 'junit.xml',
      includeUntagged: false,
    });

    expect(testCases).toHaveLength(0);
  });

  it('does not treat plain classnames as source files', () => {
    const xml = `<testsuite name="Checkout">
  <testcase classname="cart" name="works">
    <properties>
      <property name="jira" value="AUS-126" />
    </properties>
  </testcase>
</testsuite>`;

    const testCases = parseJunitXml(xml, {
      framework: 'vitest',
      inputPath: 'junit.xml',
      includeUntagged: false,
      sourceRoot: 'src',
    });

    expect(testCases).toHaveLength(1);
    expect(testCases[0]).toMatchObject({
      classname: 'cart',
      ticketKeys: ['AUS-126'],
    });
    expect(testCases[0]?.file).toBeUndefined();
  });
});
