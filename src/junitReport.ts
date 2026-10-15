import { SaxesParser } from 'saxes';
import { buildCodeUrl } from './gitMetadata';
import { testCaseSchema, type TestFramework, type TestStatus, type TestCase } from './testReportSchemas';
import { extractTicketKeys } from './ticketKeys';

export interface ParseJunitReportOptions {
  framework: TestFramework;
  inputPath: string;
  includeUntagged: boolean;
  gitUrl?: string;
  branchName?: string;
  commitSha?: string;
  sourceRoot?: string;
}

interface ActiveJunitTestCase {
  name: string;
  status: TestStatus;
  suite?: string;
  classname?: string;
  file?: string;
  durationMs?: number;
  message?: string;
  ticketKeyHints: string[];
}

interface ActiveCaseText {
  tagName: 'failure' | 'error' | 'skipped';
  message?: string;
  text: string;
}

interface ActiveJunitProperty {
  name?: string;
  value?: string;
  text: string;
}

export function parseJunitXml(xml: string, options: ParseJunitReportOptions): TestCase[] {
  const parser = new SaxesParser({
    xmlns: false,
  });
  const suiteStack: (string | undefined)[] = [];
  const testCases: TestCase[] = [];
  let activeCase: ActiveJunitTestCase | undefined = undefined;
  let activeCaseText: ActiveCaseText | undefined = undefined;
  let activeProperty: ActiveJunitProperty | undefined = undefined;
  const parserState: {
    parseError?: Error;
  } = {};

  parser.on('opentag', (tag) => {
    if (tag.name === 'testsuite') {
      suiteStack.push(readAttribute(tag.attributes, 'name'));
      return;
    }

    if (tag.name === 'testcase') {
      const name = readAttribute(tag.attributes, 'name');

      if (!name) {
        return;
      }

      activeCase = {
        name,
        status: 'passed',
        suite: readActiveSuite(suiteStack),
        classname: readAttribute(tag.attributes, 'classname'),
        file: readAttribute(tag.attributes, 'file'),
        durationMs: parseDurationMs(readAttribute(tag.attributes, 'time')),
        ticketKeyHints: [],
      };

      return;
    }

    if (activeCase && tag.name === 'property') {
      activeProperty = {
        name: readAttribute(tag.attributes, 'name'),
        value: readAttribute(tag.attributes, 'value'),
        text: '',
      };
      return;
    }

    if (!activeCase || !isCaseResultTag(tag.name)) {
      return;
    }

    activeCase.status = tag.name === 'skipped' ? 'skipped' : 'failed';
    activeCaseText = {
      tagName: tag.name,
      message: readAttribute(tag.attributes, 'message'),
      text: '',
    };
  });

  parser.on('text', (text) => {
    if (activeProperty) {
      activeProperty.text += text;
      return;
    }

    if (!activeCaseText) {
      return;
    }

    activeCaseText.text += text;
  });

  parser.on('cdata', (text) => {
    if (activeProperty) {
      activeProperty.text += text;
      return;
    }

    if (!activeCaseText) {
      return;
    }

    activeCaseText.text += text;
  });

  parser.on('closetag', (tag) => {
    if (tag.name === 'property' && activeCase && activeProperty) {
      activeCase = mergeCaseProperty(activeCase, activeProperty);
      activeProperty = undefined;
      return;
    }

    if (tag.name === activeCaseText?.tagName) {
      activeCase = mergeCaseMessage(activeCase, activeCaseText);
      activeCaseText = undefined;
      return;
    }

    if (tag.name === 'testcase' && activeCase) {
      const visibleCase = createVisibleTestCase(activeCase, options);

      if (visibleCase) {
        testCases.push(visibleCase);
      }

      activeCase = undefined;
      activeCaseText = undefined;
      activeProperty = undefined;
      return;
    }

    if (tag.name === 'testsuite') {
      suiteStack.pop();
    }
  });

  parser.on('error', (error) => {
    parserState.parseError = error;
  });

  parser.write(xml).close();

  throwParserError(parserState.parseError);

  return testCases;
}

function throwParserError(parseError: Error | undefined): void {
  if (!parseError) {
    return;
  }

  throw parseError;
}

function readAttribute(attributes: Record<string, string>, name: string): string | undefined {
  const value = attributes[name]?.trim();

  if (!value) {
    return undefined;
  }

  return value;
}

function readActiveSuite(suiteStack: readonly (string | undefined)[]): string | undefined {
  for (let index = suiteStack.length - 1; index >= 0; index -= 1) {
    const suiteName = suiteStack[index];

    if (suiteName) {
      return suiteName;
    }
  }

  return undefined;
}

function isCaseResultTag(tagName: string): tagName is ActiveCaseText['tagName'] {
  return tagName === 'failure' || tagName === 'error' || tagName === 'skipped';
}

function parseDurationMs(timeValue: string | undefined): number | undefined {
  if (!timeValue) {
    return undefined;
  }

  const seconds = Number.parseFloat(timeValue);

  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }

  return Math.round(seconds * 1000);
}

function mergeCaseMessage(
  activeCase: ActiveJunitTestCase | undefined,
  activeCaseText: ActiveCaseText,
): ActiveJunitTestCase | undefined {
  if (!activeCase) {
    return undefined;
  }

  const text = activeCaseText.text.trim();
  const message = [activeCaseText.message, text]
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!message) {
    return activeCase;
  }

  return {
    ...activeCase,
    message,
  };
}

function mergeCaseProperty(
  activeCase: ActiveJunitTestCase,
  activeProperty: ActiveJunitProperty,
): ActiveJunitTestCase {
  const ticketKeyHints = readTicketKeyPropertyHints(activeProperty);

  if (ticketKeyHints.length === 0) {
    return activeCase;
  }

  return {
    ...activeCase,
    ticketKeyHints: [
      ...activeCase.ticketKeyHints,
      ...ticketKeyHints,
    ],
  };
}

function readTicketKeyPropertyHints(activeProperty: ActiveJunitProperty): string[] {
  const propertyValue = [
    activeProperty.value,
    activeProperty.text.trim(),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!isTicketKeyPropertyName(activeProperty.name) || !propertyValue) {
    return [];
  }

  return [propertyValue];
}

function isTicketKeyPropertyName(propertyName: string | undefined): boolean {
  const normalizedPropertyName = propertyName
    ?.trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-');

  if (!normalizedPropertyName) {
    return false;
  }

  return [
    'issue',
    'issue-key',
    'jira',
    'jira-issue',
    'jira-issue-key',
    'jira-key',
    'test-key',
    'ticket',
    'ticket-key',
    'xray',
    'xray-key',
    'xray-test-key',
  ].includes(normalizedPropertyName);
}

function createVisibleTestCase(
  activeCase: ActiveJunitTestCase,
  options: ParseJunitReportOptions,
): TestCase | undefined {
  const file = resolveCaseFile(activeCase, options.sourceRoot);
  const ticketKeys = extractTicketKeys(activeCase.ticketKeyHints);

  if (ticketKeys.length === 0 && !options.includeUntagged) {
    return undefined;
  }

  return testCaseSchema.parse({
    framework: options.framework,
    name: activeCase.name,
    status: activeCase.status,
    suite: activeCase.suite,
    classname: activeCase.classname,
    file,
    codeUrl: buildCodeUrl(
      options.gitUrl,
      file,
      options.commitSha ?? options.branchName,
    ),
    durationMs: activeCase.durationMs,
    message: activeCase.message,
    ticketKeys,
  });
}

function resolveCaseFile(
  activeCase: ActiveJunitTestCase,
  sourceRoot: string | undefined,
): string | undefined {
  const explicitFile = normalizeRelativeFilePath(activeCase.file);

  if (explicitFile) {
    return explicitFile;
  }

  const classnameFile = readFilePathFromClassname(activeCase.classname);

  if (!classnameFile) {
    return undefined;
  }

  return applySourceRoot(classnameFile, sourceRoot);
}

function readFilePathFromClassname(classname: string | undefined): string | undefined {
  const normalizedClassname = normalizeRelativeFilePath(classname);

  if (!normalizedClassname || !isSourceFilePath(normalizedClassname)) {
    return undefined;
  }

  return normalizedClassname;
}

function normalizeRelativeFilePath(filePath: string | undefined): string | undefined {
  const normalizedPath = filePath
    ?.trim()
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '');

  if (!normalizedPath || normalizedPath.startsWith('/') || /^[a-z]+:/iu.test(normalizedPath)) {
    return undefined;
  }

  return normalizedPath;
}

function isSourceFilePath(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?|vue|php)$/iu.test(filePath);
}

function applySourceRoot(filePath: string, sourceRoot: string | undefined): string {
  const normalizedSourceRoot = normalizeSourceRoot(sourceRoot);

  if (!normalizedSourceRoot || filePath === normalizedSourceRoot || filePath.startsWith(`${normalizedSourceRoot}/`)) {
    return filePath;
  }

  return `${normalizedSourceRoot}/${filePath}`;
}

function normalizeSourceRoot(sourceRoot: string | undefined): string | undefined {
  const normalizedSourceRoot = sourceRoot
    ?.trim()
    .replace(/\\/gu, '/')
    .replace(/^\.?\//u, '')
    .replace(/\/+$/u, '');

  return normalizedSourceRoot || undefined;
}
