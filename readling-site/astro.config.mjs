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

// Слуги книг, объединённых в одну карточку: retired-слуг → канонический.
// Тот же файл читает src/utils/catalog.ts, поэтому 301-редиректы и страницы
// не могут разъехаться. См. комментарий в catalog.ts о том, зачем объединяли.
const BOOK_REDIRECTS = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'src/data/book-redirects.json'), 'utf8'),
);

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
        // Страницы, закрытые noindex: их нельзя оставлять в sitemap. Определяем
        // по собранному HTML, а не по отдельному списку, — тогда список не может
        // разойтись с тем, что реально стоит в разметке.
        const noindexPaths = new Set();
        let changed = 0;

        for (const file of htmlFiles(outDir)) {
          const urlPath = urlPathOf(outDir, file);
          const html = readFileSync(file, 'utf8');
          const hash = fingerprint(html);

          if (/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html)) {
            noindexPaths.add(urlPath);
          }

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
        let dropped = 0;
        // Блоки <url> из всех чанков — из них ниже собирается плоский
        // /sitemap.xml со всеми страницами сразу.
        const urlBlocks = [];
        let urlsetOpenTag = '';

        for (const name of readdirSync(outDir).filter(f => /^sitemap-\d+\.xml$/.test(f)).sort()) {
          const path = join(outDir, name);
          const source = readFileSync(path, 'utf8');
          // Открывающий тег берём из готового чанка: в нём уже объявлены все
          // пространства имён, которые проставил @astrojs/sitemap.
          if (!urlsetOpenTag) urlsetOpenTag = source.match(/<urlset[^>]*>/)?.[0] ?? '';

          const xml = source.replace(/<url>[\s\S]*?<\/url>/g, block => {
            const loc = block.match(/<loc>([^<]+)<\/loc>/);
            if (!loc) return block;
            const urlPath = new URL(loc[1]).pathname;

            // Просить обойти страницу и тут же запрещать её индексировать —
            // противоречивый сигнал: noindex-страницы из sitemap убираем.
            if (noindexPaths.has(urlPath)) {
              dropped++;
              return '';
            }

            const lastmod = lastmods.get(urlPath);
            if (!lastmod) {
              urlBlocks.push(block);
              return block;
            }
            listed.push(lastmod);
            const updated = /<lastmod>/.test(block)
              ? block.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${lastmod}</lastmod>`)
              : block.replace('</loc>', `</loc><lastmod>${lastmod}</lastmod>`);
            urlBlocks.push(updated);
            return updated;
          });
          writeFileSync(path, xml);
        }

        const indexPath = join(outDir, 'sitemap-index.xml');
        if (existsSync(indexPath)) {
          let xml = readFileSync(indexPath, 'utf8');
          if (listed.length) {
            const newest = listed.sort().at(-1);
            xml = xml.replace(
              /<sitemap>[\s\S]*?<\/sitemap>/g,
              block => (/<lastmod>/.test(block)
                ? block.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${newest}</lastmod>`)
                : block.replace('</loc>', `</loc><lastmod>${newest}</lastmod>`)),
            );
            writeFileSync(indexPath, xml);
          }
        }

        // @astrojs/sitemap пишет только `sitemap-index.xml` и чанки
        // `sitemap-N.xml`. Но по умолчанию краулеры дёргают `/sitemap.xml`,
        // и его же подставляют руками в Search Console. Раньше здесь лежал
        // 301 на индекс (Search Console считала это неудачной загрузкой),
        // потом — копия индекса. Теперь кладём сам список URL: краулеру не
        // нужен лишний переход, все страницы видны в одном файле.
        // Лимит протокола sitemap — 50 000 URL на файл; если каталог до него
        // дорастёт, откатываемся на индекс, а чанки останутся на месте.
        const FLAT_SITEMAP_LIMIT = 45000;
        if (urlBlocks.length && urlBlocks.length <= FLAT_SITEMAP_LIMIT) {
          const openTag = urlsetOpenTag || '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
          writeFileSync(
            join(outDir, 'sitemap.xml'),
            `<?xml version="1.0" encoding="UTF-8"?>${openTag}${urlBlocks.join('')}</urlset>`,
          );
        } else if (existsSync(indexPath)) {
          writeFileSync(join(outDir, 'sitemap.xml'), readFileSync(indexPath, 'utf8'));
          logger.warn(`sitemap: ${urlBlocks.length} URL — больше ${FLAT_SITEMAP_LIMIT}, в /sitemap.xml положен индекс`);
        }

        const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
        writeFileSync(MANIFEST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);

        // 301 для страниц книг, объединённых в одну карточку. Домен здесь не
        // указать — `_redirects` в Workers static assets не поддерживает
        // редиректы по хосту, поэтому www→apex настраивается Redirect Rule
        // в дашборде Cloudflare (см. README).
        const bookRedirectLines = Object.entries(BOOK_REDIRECTS)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([from, to]) => `/books/${from}/ /books/${to}/ 301`);

        writeFileSync(
          join(outDir, '_redirects'),
          `# Сгенерировано сборкой (см. astro.config.mjs) — не редактировать вручную.\n${bookRedirectLines.join('\n')}\n`,
        );

        const total = Object.keys(next).length;
        logger.info(`lastmod: изменилось ${changed} из ${total} страниц`);
        logger.info(`sitemap: ${urlBlocks.length} URL в /sitemap.xml, исключено по noindex — ${dropped}`);
        logger.info(`_redirects: ${bookRedirectLines.length} правил для объединённых книг`);
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
