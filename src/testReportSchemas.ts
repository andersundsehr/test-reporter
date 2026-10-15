import { z } from 'zod';

export const testFrameworkSchema = z.enum([
  'playwright',
  'vitest',
  'phpunit',
  'generic',
]);

export const testStatusSchema = z.enum([
  'passed',
  'failed',
  'skipped',
  'unknown',
]);

export const ticketKeySchema = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/u);

export const sourceReportSchema = z.object({
  framework: testFrameworkSchema,
  format: z.literal('junit'),
  path: z.string().min(1),
});

export const testCaseSchema = z.object({
  framework: testFrameworkSchema,
  name: z.string().min(1),
  status: testStatusSchema,
  ticketKeys: z.array(ticketKeySchema),
  suite: z.string().min(1).optional(),
  classname: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  codeUrl: z.string().url().optional(),
  durationMs: z.number().nonnegative().optional(),
  message: z.string().min(1).optional(),
});

export const testReportSchema = z.object({
  schemaVersion: z.literal(1),
  projectName: z.string().min(1),
  branchName: z.string().min(1).optional(),
  gitUrl: z.string().min(1).optional(),
  commitSha: z.string().min(7).optional(),
  pipelineUrl: z.string().url().optional(),
  reportUrl: z.string().url().optional(),
  generatedAt: z.string().datetime(),
  sourceReports: z.array(sourceReportSchema).min(1),
  tests: z.array(testCaseSchema),
});

export type TestFramework = z.infer<typeof testFrameworkSchema>;
export type TestStatus = z.infer<typeof testStatusSchema>;
export type SourceReport = z.infer<typeof sourceReportSchema>;
export type TestCase = z.infer<typeof testCaseSchema>;
export type TestReport = z.infer<typeof testReportSchema>;
