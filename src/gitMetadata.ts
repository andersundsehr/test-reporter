import { execFileSync } from 'node:child_process';
import process from 'node:process';

export interface GitMetadata {
  branchName?: string;
  gitUrl?: string;
  commitSha?: string;
  pipelineUrl?: string;
  reportUrl?: string;
}

export interface GitMetadataOverrides {
  branchName?: string;
  gitUrl?: string;
  commitSha?: string;
  pipelineUrl?: string;
  reportUrl?: string;
}

export function collectGitMetadata(overrides: GitMetadataOverrides): GitMetadata {
  return {
    branchName: overrides.branchName
      ?? readFirstEnv(['CI_COMMIT_REF_NAME', 'CI_COMMIT_BRANCH', 'BITBUCKET_BRANCH'])
      ?? runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitUrl: sanitizeGitUrl(overrides.gitUrl
      ?? readFirstEnv(['CI_REPOSITORY_URL', 'BITBUCKET_GIT_HTTP_ORIGIN', 'BITBUCKET_GIT_SSH_ORIGIN'])
      ?? runGit(['config', '--get', 'remote.origin.url'])),
    commitSha: overrides.commitSha
      ?? readFirstEnv(['CI_COMMIT_SHA', 'BITBUCKET_COMMIT'])
      ?? runGit(['rev-parse', 'HEAD']),
    pipelineUrl: overrides.pipelineUrl ?? readFirstEnv(['CI_PIPELINE_URL']),
    reportUrl: overrides.reportUrl ?? readFirstEnv(['TEST_REPORTER_REPORT_URL', 'TEST_VISIBILITY_REPORT_URL']),
  };
}

export function normalizeRepositoryUrl(gitUrl: string): string | undefined {
  const trimmedGitUrl = gitUrl.trim().replace(/\.git$/u, '');

  if (!trimmedGitUrl) {
    return undefined;
  }

  const sshMatch = /^git@([^:]+):(.+)$/u.exec(trimmedGitUrl);

  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2];

    if (!host || !path) {
      return undefined;
    }

    return `https://${host}/${path}`;
  }

  try {
    const parsedUrl = new URL(trimmedGitUrl);

    if (parsedUrl.protocol === 'ssh:') {
      const path = parsedUrl.pathname.replace(/^\//u, '');

      if (!parsedUrl.hostname || !path) {
        return undefined;
      }

      return `https://${parsedUrl.hostname}/${path}`;
    }

    parsedUrl.username = '';
    parsedUrl.password = '';
    parsedUrl.search = '';
    parsedUrl.hash = '';

    return parsedUrl.toString().replace(/\/$/u, '');
  } catch {
    return undefined;
  }
}

export function buildCodeUrl(
  gitUrl: string | undefined,
  filePath: string | undefined,
  reference: string | undefined,
): string | undefined {
  if (!gitUrl || !filePath || !reference) {
    return undefined;
  }

  const repositoryUrl = normalizeRepositoryUrl(gitUrl);

  if (!repositoryUrl) {
    return undefined;
  }

  const cleanFilePath = filePath.replace(/^\.\//u, '');
  const encodedFilePath = cleanFilePath.split('/').map(encodeURIComponent).join('/');
  const encodedReference = encodeURIComponent(reference);
  const lowerRepositoryUrl = repositoryUrl.toLowerCase();

  if (lowerRepositoryUrl.includes('gitlab')) {
    return `${repositoryUrl}/-/blob/${encodedReference}/${encodedFilePath}`;
  }

  if (lowerRepositoryUrl.includes('bitbucket')) {
    return `${repositoryUrl}/src/${encodedReference}/${encodedFilePath}`;
  }

  return `${repositoryUrl}/blob/${encodedReference}/${encodedFilePath}`;
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

function runGit(args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function sanitizeGitUrl(gitUrl: string | undefined): string | undefined {
  if (!gitUrl) {
    return undefined;
  }

  return normalizeRepositoryUrl(gitUrl) ?? gitUrl.trim();
}
