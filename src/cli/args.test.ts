import { describe, it, expect } from 'vitest';
import { parseCliArgs } from './args.js';

// Simulate how Node sets process.argv: ['node', 'script.js', ...userArgs]
function argv(...args: string[]): string[] {
  return ['node', '/path/to/index.js', ...args];
}

describe('parseCliArgs', () => {
  it('defaults dir to "." when --dir is absent', () => {
    expect(parseCliArgs(argv()).dir).toBe('.');
  });

  it('parses --dir with space-separated value', () => {
    expect(parseCliArgs(argv('--dir', '/tmp/files')).dir).toBe('/tmp/files');
  });

  it('parses --dir=value syntax', () => {
    expect(parseCliArgs(argv('--dir=/tmp/files')).dir).toBe('/tmp/files');
  });

  it('defaults skipTransfers to false', () => {
    expect(parseCliArgs(argv()).skipTransfers).toBe(false);
  });

  it('sets skipTransfers when --skip-transfers is present', () => {
    expect(parseCliArgs(argv('--skip-transfers')).skipTransfers).toBe(true);
  });

  it('defaults dryRun to false', () => {
    expect(parseCliArgs(argv()).dryRun).toBe(false);
  });

  it('sets dryRun when --dry-run is present', () => {
    expect(parseCliArgs(argv('--dry-run')).dryRun).toBe(true);
  });

  it('handles multiple flags together', () => {
    const result = parseCliArgs(argv('--dir', '/data', '--skip-transfers', '--dry-run'));
    expect(result.dir).toBe('/data');
    expect(result.skipTransfers).toBe(true);
    expect(result.dryRun).toBe(true);
  });
});
