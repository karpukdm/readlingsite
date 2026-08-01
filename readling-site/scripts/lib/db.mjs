// Общее для скриптов выгрузки из БД приложения booktranslator.
//
// Текст книг живёт только в БД приложения (локальный Postgres в docker). Прод-сайт
// собирается на Cloudflare без доступа к ней, поэтому все производные данные
// выгружаются офлайн и коммитятся в репозиторий как JSON в src/data/.
// Сборка сайта от БД не зависит.
//
// Запуск любого из скриптов требует поднятого контейнера translator-postgres-1.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CONTAINER = process.env.PG_CONTAINER || 'translator-postgres-1';
const DB_USER = process.env.PG_USER || 'user';
const DB_NAME = process.env.PG_DB || 'book_translator';

/** Корень пакета readling-site — от него строятся пути к src/data. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Выполняет SQL, который обязан вернуть ровно одну колонку с JSON.
 * Буфер поднят: полный текст книги — это сотни тысяч слов.
 */
export function psqlJson(sql) {
  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  ).trim();
  return out ? JSON.parse(out) : null;
}

/**
 * Связь книг сайта и БД — по image_url (уникален, совпадает 1:1).
 * Протокол отбрасываем: в выгрузке сайта и в БД он местами расходится (http/https).
 */
export const normUrl = u => (u || '').trim().replace(/^https?:/, '');

// --- toSlug: копия src/utils/slug.ts (дублируем, чтобы не тащить TS-загрузчик) ---
const translitMap = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

export function toSlug(title) {
  return title.toLowerCase().split('').map(ch => translitMap[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Книги сайта, сопоставленные с БД: normUrl(image_url) -> { slug, mode }.
 * Служебные записи приложения («Руководство пользователя», «Guide») — не книги.
 */
export function siteBooksByImage(booksJson) {
  const map = new Map();
  for (const b of booksJson) {
    if (b.title.includes('Guide') || b.title.includes('Руководство')) continue;
    map.set(normUrl(b.image_url), {
      slug: toSlug(b.title),
      mode: b.mode === 'параллельный' ? 'parallel' : 'immersion',
    });
  }
  return map;
}
