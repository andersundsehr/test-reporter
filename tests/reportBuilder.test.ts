import { describe, expect, it } from 'vitest';
import { parseTestFramework } from '../src/reportBuilder';

describe('parseTestFramework', () => {
  it('accepts generic JUnit producers', () => {
    expect(parseTestFramework('generic')).toBe('generic');
  });

  it('rejects the former unknown fallback', () => {
    expect(() => parseTestFramework('unknown')).toThrow();
  });
});
