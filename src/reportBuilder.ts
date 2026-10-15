import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectGitMetadata, type GitMetadataOverrides } from './gitMetadata';
import { parseJunitXml } from './junitReport';
import {
  testFrameworkSchema,
  testReportSchema,
  type TestFramework,
  type TestReport,
} from './testReportSchemas';

export interface BuildTestReportOptions extends GitMetadataOverrides {
  framework: TestFramework;
  inputPath: string;
  outputPath?: string;
  projectName: string;
  includeUntagged: boolean;
  sourceRoot?: string;
}

export async function buildTestReport(
  options: BuildTestReportOptions,
): Promise<TestReport> {
  const metadata = collectGitMetadata(options);
  const xml = await readFile(options.inputPath, 'utf8');
  const tests = parseJunitXml(xml, {
    framework: options.framework,
    inputPath: options.inputPath,
    includeUntagged: options.includeUntagged,
    gitUrl: metadata.gitUrl,
    branchName: metadata.branchName,
    commitSha: metadata.commitSha,
    sourceRoot: options.sourceRoot,
  });

  const report = testReportSchema.parse({
    schemaVersion: 1,
    projectName: options.projectName,
    branchName: metadata.branchName,
    gitUrl: metadata.gitUrl,
    commitSha: metadata.commitSha,
    pipelineUrl: metadata.pipelineUrl,
    reportUrl: metadata.reportUrl,
    generatedAt: new Date().toISOString(),
    sourceReports: [
      {
        framework: options.framework,
        format: 'junit',
        path: options.inputPath,
      },
    ],
    tests,
  });

  if (options.outputPath) {
    await writeTestReport(report, options.outputPath);
  }

  return report;
}

export async function readTestReport(reportPath: string): Promise<TestReport> {
  const rawReport = await readFile(reportPath, 'utf8');
  const reportData: unknown = JSON.parse(rawReport);

  return testReportSchema.parse(reportData);
}

export async function writeTestReport(
  report: TestReport,
  outputPath: string,
): Promise<void> {
  await mkdir(path.dirname(outputPath), {
    recursive: true,
  });
  await writeFile(outputPath, `${JSON.stringify(report, undefined, 2)}\n`);
}

export function parseTestFramework(framework: string): TestFramework {
  return testFrameworkSchema.parse(framework);
}
