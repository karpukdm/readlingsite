// Экспорт отрывков книг (первые ~2 страницы) из БД приложения booktranslator в статический JSON.
//
// Зачем: на страницах книг нужен реальный отрывок в том же виде, как в приложении:
//   - книги в параллельном режиме  -> английский оригинал и русский перевод рядом;
//   - книги в режиме погружения     -> русский текст с вплетённым английским (простые фразы
//                                       переходят на английский первыми), как в hybrid-режиме.
// Текст книг живёт только в БД приложения (локальный Postgres в docker). Прод-сайт собирается
// на Cloudflare без доступа к ней, поэтому отрывки выгружаются офлайн и коммитятся в репо как
// src/data/excerpts.json. Сборка от БД не зависит.
//
// Запуск (нужен поднятый контейнер translator-postgres-1):
//   node scripts/export-excerpts.mjs
//
// Связь книг сайта и БД — по image_url (уникален, совпадает 1:1).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const CONTAINER = process.env.PG_CONTAINER || 'translator-postgres-1';
const DB_USER = process.env.PG_USER || 'user';
const DB_NAME = process.env.PG_DB || 'book_translator';

// Сколько текста кладём в отрывок (примерно пара страниц) и отсев заголовков.
const MAX_SENTENCES = 10;
const MAX_RU_CHARS = 1100;
const MIN_EN_LEN = 25; // первая «настоящая» фраза не короче (отсекаем заголовок главы)

// --- toSlug: копия src/utils/slug.ts (дублируем, чтобы не тащить TS-загрузчик) ---
const translitMap = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};
function toSlug(title) {
  return title.toLowerCase().split('').map(ch => translitMap[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function psqlJson(sql) {
  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  ).trim();
  return out ? JSON.parse(out) : null;
}

const normUrl = u => (u || '').trim().replace(/^https?:/, '');

// 1. Книги сайта: image_url -> { slug, mode }
const siteBooks = JSON.parse(readFileSync(join(ROOT, 'src/data/books.json'), 'utf8'))
  .filter(b => !b.title.includes('Guide') && !b.title.includes('Руководство'));
const metaByImg = new Map();
for (const b of siteBooks) {
  metaByImg.set(normUrl(b.image_url), {
    slug: toSlug(b.title),
    mode: b.mode === 'параллельный' ? 'parallel' : 'immersion',
  });
}

// 2. Тянем из БД предложения первой главы (с фразами) каждой переведённой книги.
//    text/translatedText и phrase.original/translated — в original_language/translated_language.
const rows = psqlJson(`
  SELECT COALESCE(json_agg(j), '[]'::json) FROM (
    SELECT b.image_url AS img,
           b.original_language AS lang,
           b.pages_count AS pages,
           (SELECT count(*) FROM chapters WHERE book_id = b.id) AS chapters,
           ( SELECT json_agg(
               jsonb_build_object('t', s.value->>'text', 'tt', s.value->>'translatedText', 'ph', s.value->'phrases')
               ORDER BY p.pord, (s.value->>'orderId')::int
             )
             FROM chapters c
             CROSS JOIN LATERAL jsonb_array_elements(c.paragraphs) WITH ORDINALITY p(value, pord)
             CROSS JOIN LATERAL jsonb_array_elements(p.value->'sentences') s(value)
             WHERE c.book_id = b.id
               -- всегда первая глава книги (chapter 0 — первая страница, как в приложении)
               AND c.order_id = (SELECT min(order_id) FROM chapters WHERE book_id = b.id)
               AND p.pord <= 14
           ) AS sents
    FROM books b
    WHERE b.status = 'TRANSLATED'
  ) j
`);

// 3. Собираем excerpts.json и book-stats.json (реальные данные книги: страницы, главы).
const excerpts = {};
const stats = {};
let matched = 0;
for (const row of rows || []) {
  const meta = metaByImg.get(normUrl(row.img));
  if (!meta || !Array.isArray(row.sents)) continue;
  const fromEnglish = row.lang === 'ENGLISH';

  // Реальная статистика — для всех совпавших книг (даже без отрывка)
  const pages = Number(row.pages) || 0;
  const chapters = Number(row.chapters) || 0;
  if (pages || chapters) stats[meta.slug] = { pages, chapters };

  const sentences = [];
  let ruChars = 0;
  for (const s of row.sents) {
    if (!s) continue;
    const ru = ((fromEnglish ? s.tt : s.t) || '').trim();
    const en = ((fromEnglish ? s.t : s.tt) || '').trim();
    if (!ru || !en) continue;
    if (sentences.length === 0 && en.length < MIN_EN_LEN) continue; // пропускаем заголовок

    const phrases = Array.isArray(s.ph)
      ? s.ph
          .map(p => ({
            ru: ((fromEnglish ? p.translated : p.original) || '').trim(),
            en: ((fromEnglish ? p.original : p.translated) || '').trim(),
            cx: typeof p.complexity === 'number' ? p.complexity : 3,
          }))
          .filter(p => p.ru && p.en)
      : [];

    sentences.push({ en, ru, phrases });
    ruChars += ru.length;
    if (sentences.length >= MAX_SENTENCES || ruChars >= MAX_RU_CHARS) break;
  }

  if (sentences.length >= 2) {
    excerpts[meta.slug] = { mode: meta.mode, sentences };
    matched++;
  }
}

writeFileSync(join(ROOT, 'src/data/excerpts.json'), JSON.stringify(excerpts) + '\n');
writeFileSync(join(ROOT, 'src/data/book-stats.json'), JSON.stringify(stats) + '\n');
const sz = (JSON.stringify(excerpts).length / 1024).toFixed(0);
console.log(`Готово: ${matched} отрывков (${sz} KB) + ${Object.keys(stats).length} stat-записей из ${siteBooks.length} книг сайта.`);
