# Test Reporter

Test Reporter turns JUnit XML from Playwright, Vitest, PHPUnit, or another test framework into ticket-scoped results and submits them to a central service that owns the Jira credentials.

## Easiest setup: GitLab CI

Add one include to the project's `.gitlab-ci.yml`:

```yaml
include:
  - remote: https://raw.githubusercontent.com/andersundsehr/test-reporter/v1.0.0/templates/gitlab-ci.yml
```

The template adds a `test_reporter` job to GitLab's built-in `.post` stage. The job downloads no dependencies, automatically finds a supported JUnit file, creates the report, and submits it. If no JUnit file exists, it exits successfully.

Configure these variables once at GitLab group level so individual projects only need the include:

```text
TEST_REPORTER_ENDPOINT=https://test-reporter.example.com/reports
TEST_REPORTER_TOKEN=<ingest token>
```

The preceding test job must preserve its JUnit XML as an artifact, even when tests fail. For example:

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

The reporter automatically checks these paths:

- `.playwright/junit.xml`
- `.test-reporter/vitest-junit.xml`
- `.test-reporter/phpunit-junit.xml`
- `.test-reporter/junit.xml`
- `junit.xml`

For reproducible builds, use the same release tag in the template URL and container image:

```yaml
test_reporter:
  variables:
    TEST_REPORTER_IMAGE: ghcr.io/andersundsehr/test-reporter:v1.0.0
```

If artifact downloads should be restricted to specific jobs, override `needs`:

```yaml
test_reporter:
  needs:
    - job: playwright
      artifacts: true
```

## One-command usage

The complete local or CI workflow is:

```bash
test-reporter run
```

`run` detects JUnit XML, builds validated JSON, and submits it to `TEST_REPORTER_ENDPOINT`. It fails with a clear error if the central endpoint is missing.

Paths and framework can still be explicit:

```bash
test-reporter run --framework phpunit --input build/junit.xml
```

Supported frameworks are `playwright`, `vitest`, `phpunit`, and `generic`. Use `generic` for standard JUnit XML from another framework.

## Standalone installation

The container-based GitLab setup above is recommended. For local use or CI systems without containers, install the standalone release bundle:

```bash
curl --fail --silent --show-error --location \
  https://github.com/andersundsehr/test-reporter/releases/latest/download/install.sh \
  --output /tmp/install-test-reporter.sh

source /tmp/install-test-reporter.sh
test-reporter run
```

This requires Node.js 22 or newer, Bash, and curl. Set `TEST_REPORTER_BASE_URL` before sourcing the installer to pin a release or use another distribution location.

## Link tests to Jira

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

## Central server

The recommended architecture keeps Jira credentials in one central service. Client projects only receive the reporter endpoint and an ingest token.

Server configuration:

```text
JIRA_BASE_URL=https://example.atlassian.net
JIRA_EMAIL=jira-service@example.com
JIRA_API_TOKEN=<Jira API token>
JIRA_DRY_RUN=false
TEST_REPORTER_INGEST_TOKEN=<ingest token>
TEST_REPORTER_HOST=0.0.0.0
TEST_REPORTER_PORT=3099
```

Run the released container as a service, or run it locally:

```bash
yarn serve --host 0.0.0.0 --port 3099
```

The server exposes `GET /health` and authenticated `POST /reports` endpoints. It validates incoming reports, publishes relevant status changes to Jira, and then discards the report without storing it.

## Development

```bash
corepack enable
yarn install
yarn typecheck
yarn test
yarn build
```

The standalone bundle is written to `dist/test-reporter.cjs`.

## Reporting behavior

The ticket result is green when all linked tests pass, red when at least one fails, and grey when tests are skipped or unknown without failures. A Jira comment is added only when that aggregate result changes for the same project, branch, and test runner.
