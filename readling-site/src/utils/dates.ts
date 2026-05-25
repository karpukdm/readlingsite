import { execFileSync } from 'node:child_process';

const BUILD_TIME = new Date();
const cache = new Map<string, { published: Date; modified: Date }>();

function gitDate(relPath: string, filterAdded: boolean): Date {
  try {
    const args = ['log'];
    if (filterAdded) args.push('--diff-filter=A');
    args.push('--follow', '--format=%aI', '--', relPath);
    const out = execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return BUILD_TIME;
    const lines = out.split('\n').filter(Boolean);
    const iso = filterAdded ? lines[lines.length - 1] : lines[0];
    return iso ? new Date(iso) : BUILD_TIME;
  } catch {
    return BUILD_TIME;
  }
}

export function getPageDates(relPath: string): { datePublished: string; dateModified: string } {
  if (!cache.has(relPath)) {
    cache.set(relPath, {
      published: gitDate(relPath, true),
      modified: gitDate(relPath, false),
    });
  }
  const { published, modified } = cache.get(relPath)!;
  return {
    datePublished: published.toISOString(),
    dateModified: modified.toISOString(),
  };
}
