// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const SITE = 'https://readling.club';
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const BUILD_TIME = new Date().toISOString();

// Реестр «когда страница менялась в последний раз». Коммитится в git.
// Ключ — путь страницы, значение — отпечаток её HTML и дата последней правки.
const MANIFEST_PATH = join(PROJECT_ROOT, 'lastmod-manifest.json');

// Страницы рендерят этот токен вместо dateModified (см. src/utils/dates.ts),
// а хук astro:build:done подставляет вместо него реальную дату — ту же, что
// уходит в sitemap. Иначе dateModified в JSON-LD равнялся бы времени сборки.
const LASTMOD_TOKEN = '__LASTMOD_PLACEHOLDER__';

function htmlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, acc);
    else if (entry.name.endsWith('.html')) acc.push(full);
  }
  return acc;
}

function urlPathOf(outDir, file) {
  const rel = relative(outDir, file).split(sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel}`;
}

function fingerprint(html) {
  const normalized = html
    // сам токен даты не должен влиять на отпечаток
    .replaceAll(LASTMOD_TOKEN, '')
    // Хеш в имени бандла пересчитывается при любой правке CSS/JS, поэтому
    // без этого одна правка стилей «обновляла» бы разом все страницы.
    .replace(/(\/_assets\/[^"'\s]+?)\.[A-Za-z0-9_-]{8,}\.(css|js)/g, '$1.$2');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Проставляет lastmod по факту изменения содержимого страницы, а не по времени
 * сборки: HTML каждой страницы хешируется и сверяется с закоммиченным
 * реестром. Совпал хеш — дата остаётся прежней, изменился — ставится текущая.
 *
 * Раньше даты брались из `git log` по файлу-источнику, но Cloudflare клонирует
 * репозиторий с --depth=1: в сборке виден только один коммит, поэтому git
 * отдавал его дату для всех файлов и все 122 URL получали одинаковый свежий
 * lastmod при каждом деплое.
 */
function lastmodTracker() {
  let outDir = '';

  return {
    name: 'lastmod-tracker',
    hooks: {
      'astro:config:done': ({ config }) => {
        outDir = fileURLToPath(config.outDir);
      },

      'astro:build:done': ({ logger }) => {
        const previous = existsSync(MANIFEST_PATH)
          ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
          : {};

        const next = {};
        const lastmods = new Map();
        let changed = 0;

        for (const file of htmlFiles(outDir)) {
          const urlPath = urlPathOf(outDir, file);
          const html = readFileSync(file, 'utf8');
          const hash = fingerprint(html);

          const prev = previous[urlPath];
          const isSame = prev && prev.hash === hash;
          const lastmod = isSame ? prev.lastmod : BUILD_TIME;
          if (!isSame) changed++;

          next[urlPath] = { hash, lastmod };
          lastmods.set(urlPath, lastmod);

          if (html.includes(LASTMOD_TOKEN)) {
            writeFileSync(file, html.replaceAll(LASTMOD_TOKEN, lastmod));
          }
        }

        // Даты только тех страниц, что реально попали в sitemap: 404.html
        // и прочие невыгружаемые страницы не должны влиять на sitemap-index.
        const listed = [];

        for (const name of readdirSync(outDir).filter(f => /^sitemap-\d+\.xml$/.test(f))) {
          const path = join(outDir, name);
          const xml = readFileSync(path, 'utf8').replace(/<url>[\s\S]*?<\/url>/g, block => {
            const loc = block.match(/<loc>([^<]+)<\/loc>/);
            if (!loc) return block;
            const lastmod = lastmods.get(new URL(loc[1]).pathname);
            if (!lastmod) return block;
            listed.push(lastmod);
            return /<lastmod>/.test(block)
              ? block.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${lastmod}</lastmod>`)
              : block.replace('</loc>', `</loc><lastmod>${lastmod}</lastmod>`);
          });
          writeFileSync(path, xml);
        }

        const indexPath = join(outDir, 'sitemap-index.xml');
        if (existsSync(indexPath) && listed.length) {
          const newest = listed.sort().at(-1);
          const xml = readFileSync(indexPath, 'utf8').replace(
            /<sitemap>[\s\S]*?<\/sitemap>/g,
            block => (/<lastmod>/.test(block)
              ? block.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${newest}</lastmod>`)
              : block.replace('</loc>', `</loc><lastmod>${newest}</lastmod>`)),
          );
          writeFileSync(indexPath, xml);
        }

        const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
        writeFileSync(MANIFEST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);

        const total = Object.keys(next).length;
        logger.info(`lastmod: изменилось ${changed} из ${total} страниц`);
        if (!Object.keys(previous).length) {
          logger.warn('lastmod-manifest.json создан заново — не забудьте закоммитить его');
        } else if (changed > total / 2) {
          logger.warn(`lastmod: изменилось больше половины страниц (${changed}/${total}) — проверьте, что реестр закоммичен и актуален`);
        }
      },
    },
  };
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
        // Дата-заглушка: реальные значения подставит lastmodTracker,
        // здесь важно лишь чтобы тег <lastmod> присутствовал.
        const lastmod = BUILD_TIME;

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
    lastmodTracker(),
  ],
  build: {
    assets: '_assets',
  },
});
