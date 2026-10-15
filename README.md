# Test Reporter

Test Reporter converts JUnit XML into ticket-based test results and publishes them to Jira through a central service.

```text
GitLab pipeline → Test Reporter service → Jira
```

Jira credentials exist only on the central service. Project pipelines receive an endpoint and an ingest token, and reports are not stored by the service.

## Add it to a GitLab project

Include a released version of the CI template in `.gitlab-ci.yml`:

```yaml
include:
  - remote: https://raw.githubusercontent.com/andersundsehr/test-reporter/v1.0.0/templates/gitlab-ci.yml

test_reporter:
  variables:
    TEST_REPORTER_IMAGE: ghcr.io/andersundsehr/test-reporter:v1.0.0
```

Replace `v1.0.0` with the release you want to use. Pinning the template and container image to the same version makes pipeline updates predictable.

Configure these masked GitLab group variables once for all participating projects:

```text
TEST_REPORTER_ENDPOINT=https://test-reporter.example.com/reports
TEST_REPORTER_TOKEN=<ingest token>
```

Mark them as protected only when the reporting job runs exclusively on protected branches or tags.

The included template adds a `test_reporter` job to GitLab's `.post` stage. It runs `test-reporter run`, detects the JUnit file, builds the report, and submits it to the central service. If no JUnit file exists, the job exits successfully.

## Provide JUnit results

The test job must preserve its JUnit XML as an artifact, including when tests fail:

```yaml
playwright:
  stage: test
  script:
    - yarn playwright test
  artifacts:
    when: always
    paths:
      - .playwright/junit.xml
    reports:
      junit: .playwright/junit.xml
```

Test Reporter automatically checks:

- `.playwright/junit.xml`
- `.test-reporter/vitest-junit.xml`
- `.test-reporter/phpunit-junit.xml`
- `.test-reporter/junit.xml`
- `junit.xml`

Supported frameworks are `playwright`, `vitest`, `phpunit`, and `generic`. An explicit path and framework can be configured when required:

```yaml
test_reporter:
  variables:
    TEST_REPORTER_FRAMEWORK: phpunit
    TEST_REPORTER_INPUT: build/junit.xml
```

To download artifacts only from specific jobs, configure `needs`:

```yaml
test_reporter:
  needs:
    - job: playwright
      artifacts: true
```

## Link tests to Jira issues

Playwright:

```ts
test('adds a ticket to the cart', {
  annotation: {
    type: 'jira',
    description: 'ABC-123',
  },
}, async ({ page }) => {
  // Test implementation
});
```

Vitest:

```ts
it('adds a ticket to the cart', async ({ annotate }) => {
  await annotate('ABC-123', 'jira');
  // Test implementation
});
```

PHPUnit and other JUnit producers can add ticket metadata to a test case:

```xml
<properties>
  <property name="jira" value="ABC-123" />
</properties>
```

## Run the central service

Create a `.env` file from `.env.dist` and enter the real credentials:

```text
JIRA_BASE_URL=https://example.atlassian.net
JIRA_EMAIL=jira-service@example.com
JIRA_API_TOKEN=<Jira API token>
JIRA_DRY_RUN=false
TEST_REPORTER_INGEST_TOKEN=<long random token>
```

Start the service:

```bash
docker compose up -d
```

The service exposes:

- `GET /health` for health checks
- `POST /reports` for authenticated report submission

It validates each report, updates Jira, and discards the report without writing it to disk. The provided Compose configuration exposes the service on `127.0.0.1:3099`, ready for a reverse proxy on the host.

## Optional standalone CLI

For local use or CI systems without container support:

```bash
curl --fail --silent --show-error --location \
  https://github.com/andersundsehr/test-reporter/releases/latest/download/install.sh \
  --output /tmp/install-test-reporter.sh

source /tmp/install-test-reporter.sh
test-reporter run
```

This requires Node.js 22 or newer, Bash, curl, `TEST_REPORTER_ENDPOINT`, and `TEST_REPORTER_TOKEN`.

## Reporting behavior

For each Jira issue, the aggregate result is:

- green when all linked tests pass
- red when at least one linked test fails
- grey when tests are skipped or have an unknown status and none fail

A Jira comment is added only when the aggregate result changes for the same project, branch, and test runner.

## Development

```bash
corepack enable
yarn install
yarn typecheck
yarn test
yarn build
```

The standalone bundle is written to `dist/test-reporter.cjs`.
