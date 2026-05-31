// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import cloudflare from '@astrojs/cloudflare';

const SITE = 'https://readling.club';
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const BUILD_TIME = new Date();

const gitDateCache = new Map();
function gitLastmod(relPath) {
  if (gitDateCache.has(relPath)) return gitDateCache.get(relPath);
  let date = BUILD_TIME;
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%aI', '--', relPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (iso) date = new Date(iso);
  } catch {
    // git unavailable (shallow CI clone, etc.) — fall back to build time
  }
  gitDateCache.set(relPath, date);
  return date;
}

function maxDate(...dates) {
  return new Date(Math.max(...dates.map(d => d.getTime())));
}

function resolveLastmod(url) {
  const path = url.replace(SITE, '').replace(/\/+$/, '') || '/';

  if (path === '/') return gitLastmod('src/pages/index.astro');
  if (path === '/books') return gitLastmod('src/pages/books/index.astro');
  if (path.startsWith('/books/')) {
    return maxDate(
      gitLastmod('src/pages/books/[slug].astro'),
      gitLastmod('src/data/books.json'),
    );
  }
  if (path === '/metod-pogruzheniya') return gitLastmod('src/pages/metod-pogruzheniya.astro');
  if (path === '/parallelnoe-chtenie') return gitLastmod('src/pages/parallelnoe-chtenie.astro');
  if (path.startsWith('/uroven/')) return gitLastmod('src/pages/uroven/[level].astro');
  if (path === '/pricing') return gitLastmod('src/pages/pricing.astro');
  if (path === '/o-readling') return gitLastmod('src/pages/o-readling.astro');
  if (path === '/sravnenie/readling-vs-duolingo') {
    return gitLastmod('src/pages/sravnenie/readling-vs-duolingo.astro');
  }
  return BUILD_TIME;
}

export default defineConfig({
  site: SITE,
  output: 'static',
  trailingSlash: 'always',

  integrations: [
    sitemap({
      changefreq: 'weekly',
      priority: 0.5,
      serialize(item) {
        const url = item.url;
        const lastmod = resolveLastmod(url).toISOString();

        // Главная — высший приоритет, обновляется еженедельно
        if (/\/$/.test(url) && url.replace(/\/$/, '') === SITE) {
          return { ...item, lastmod, priority: 1.0, changefreq: 'weekly' };
        }

        // Тематические лендинги (метод, параллельное чтение, цены, сравнения) — высокий приоритет
        if (/\/(metod-pogruzheniya|parallelnoe-chtenie|pricing|sravnenie)\//.test(url)) {
          return { ...item, lastmod, priority: 0.9, changefreq: 'monthly' };
        }

        // Страницы по уровням (A1–C2) — высокий приоритет
        if (/\/uroven\/[^/]+\/$/.test(url)) {
          return { ...item, lastmod, priority: 0.8, changefreq: 'monthly' };
        }

        // О компании — средне-высокий приоритет, обновляется редко
        if (/\/o-readling\/$/.test(url)) {
          return { ...item, lastmod, priority: 0.7, changefreq: 'yearly' };
        }

        // Каталог книг
        if (/\/books\/$/.test(url)) {
          return { ...item, lastmod, priority: 0.9, changefreq: 'weekly' };
        }

        // Страницы отдельных книг — средний приоритет
        if (/\/books\/[^/]+\/$/.test(url)) {
          return { ...item, lastmod, priority: 0.6, changefreq: 'monthly' };
        }

        return { ...item, lastmod, priority: 0.5, changefreq: 'monthly' };
      },
    }),
  ],

  build: {
    assets: '_assets',
  },

  adapter: cloudflare()
});