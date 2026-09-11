/**
 * Пинг IndexNow: сообщает Bing (и другим движкам протокола), какие страницы
 * изменились, чтобы они переобошли их сразу, а не когда дойдут руки.
 *
 * Запускать ВРУЧНУЮ И ПОСЛЕ ДЕПЛОЯ. Сборка идёт на стороне Cloudflare из ветки
 * main, и хука «деплой доехал» у нас нет: пинг из `astro:build:done` позвал бы
 * краулер на старую версию страницы. Поэтому скрипт сам проверяет, что на
 * проде уже лежит то, что лежит в `lastmod-manifest.json`, и отказывается
 * слать URL, для которых это не так.
 *
 *   npm run indexnow            — отправить страницы из последней сборки
 *   npm run indexnow -- --dry   — показать список и ничего не отправлять
 *   npm run indexnow -- /books/1984/ /pricing/   — отправить конкретные URL
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'lastmod-manifest.json');
const PUBLIC_DIR = join(ROOT, 'public');
const SITE = 'https://readling.club';
const HOST = 'readling.club';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const LASTMOD_TOKEN = '__LASTMOD_PLACEHOLDER__';

/** Ровно тот же отпечаток, что считает lastmodTracker в astro.config.mjs. */
function fingerprint(html) {
  const normalized = html
    .replaceAll(LASTMOD_TOKEN, '')
    .replace(/(\/_assets\/[^"'\s]+?)\.[A-Za-z0-9_-]{8,}\.(css|js)/g, '$1.$2');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Ключ лежит в `public/<key>.txt` и находится по имени файла, а не по
 * константе: так нельзя разъехаться с тем, что реально отдаёт сайт.
 */
function readKey() {
  const files = readdirSync(PUBLIC_DIR).filter(f => /^[a-f0-9]{32}\.txt$/.test(f));
  if (files.length !== 1) {
    throw new Error(`в public/ ожидался ровно один файл ключа <32 hex>.txt, найдено: ${files.length}`);
  }
  const key = readFileSync(join(PUBLIC_DIR, files[0]), 'utf8').trim();
  if (`${key}.txt` !== files[0]) {
    throw new Error(`содержимое ${files[0]} не совпадает с именем файла`);
  }
  return key;
}

/**
 * Живая страница совпадает с манифестом? В HTML вместо токена уже подставлена
 * дата, поэтому перед подсчётом отпечатка возвращаем её обратно в пустоту —
 * ровно то, что делает fingerprint с самим токеном.
 */
async function isDeployed(urlPath, entry) {
  const res = await fetch(SITE + urlPath, { redirect: 'manual' });
  if (res.status !== 200) return { ok: false, why: `HTTP ${res.status}` };
  const html = (await res.text()).replaceAll(entry.lastmod, '');
  const live = fingerprint(html);
  return live === entry.hash ? { ok: true } : { ok: false, why: `отпечаток ${live} ≠ ${entry.hash}` };
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const explicit = args.filter(a => a.startsWith('/'));

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

// По умолчанию — страницы последней сборки: у них lastmod самый свежий.
// 404 и прочее, чего нет в sitemap, сюда не попадает: sitemap собирается тем же
// хуком и уже вычистил noindex.
const sitemap = readFileSync(join(ROOT, 'dist/sitemap.xml'), 'utf8');
const inSitemap = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname));

let paths;
if (explicit.length) {
  paths = explicit;
} else {
  const newest = Object.values(manifest).map(e => e.lastmod).sort().at(-1);
  paths = Object.entries(manifest)
    .filter(([, e]) => e.lastmod === newest)
    .map(([p]) => p);
}
paths = paths.filter(p => inSitemap.has(p)).sort();

if (!paths.length) {
  console.log('нечего отправлять: в последней сборке не изменилась ни одна страница из sitemap');
  process.exit(0);
}

console.log(`кандидатов: ${paths.length}`);

const ready = [];
const skipped = [];
for (const p of paths) {
  const entry = manifest[p];
  if (!entry) { skipped.push([p, 'нет в манифесте']); continue; }
  const { ok, why } = await isDeployed(p, entry);
  (ok ? ready : skipped).push(ok ? p : [p, why]);
}

for (const [p, why] of skipped) console.log(`  пропуск  ${p} — ${why}`);
console.log(`готовы к отправке: ${ready.length}`);

if (skipped.length && !ready.length) {
  console.error('\nна проде ещё старая версия — сначала дождитесь деплоя');
  process.exit(1);
}
if (dry) {
  for (const p of ready) console.log(`  ${SITE}${p}`);
  process.exit(0);
}
if (!ready.length) process.exit(0);

const key = readKey();
const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    host: HOST,
    key,
    keyLocation: `${SITE}/${key}.txt`,
    urlList: ready.map(p => SITE + p),
  }),
});

// 200 — приняли, 202 — приняли, ключ проверят позже. Всё остальное — ошибка:
// 400 формат, 403 ключ не найден, 422 URL не с того хоста, 429 перебор.
const meaning = { 200: 'принято', 202: 'принято, ключ проверяется', 400: 'неверный формат',
  403: 'ключ не найден или не совпал', 422: 'URL не с этого хоста', 429: 'слишком часто' };
console.log(`\n${ENDPOINT} → ${res.status} ${meaning[res.status] ?? ''}`);
if (res.status !== 200 && res.status !== 202) {
  console.error(await res.text());
  process.exit(1);
}
console.log(`отправлено URL: ${ready.length}`);
