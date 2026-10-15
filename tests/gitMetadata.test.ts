import { describe, expect, it } from 'vitest';
import { buildCodeUrl, normalizeRepositoryUrl } from '../src/gitMetadata';

describe('gitMetadata', () => {
  it('normalizes SSH remotes to HTTPS repository URLs', () => {
    expect(normalizeRepositoryUrl('git@gitlab.example.com:group/project.git')).toBe('https://gitlab.example.com/group/project');
    expect(normalizeRepositoryUrl('ssh://gitlab.example.com:10022/group/project.git')).toBe('https://gitlab.example.com/group/project');
  });

  it('builds GitLab and Bitbucket file backlinks', () => {
    expect(buildCodeUrl(
      'git@gitlab.example.com:group/project.git',
      'src/cart.test.ts',
      'abc1234',
    )).toBe('https://gitlab.example.com/group/project/-/blob/abc1234/src/cart.test.ts');
    expect(buildCodeUrl(
      'git@bitbucket.example.com:group/project.git',
      'src/cart.test.ts',
      'feature/test',
    )).toBe('https://bitbucket.example.com/group/project/src/feature%2Ftest/src/cart.test.ts');
  });
});
