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

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, psqlJson, normUrl, toSlug, siteBooksByImage } from './lib/db.mjs';

// Сколько текста кладём в отрывок и отсев заголовков.
//
// Раньше здесь стояло 10 предложений (~1100 знаков) — примерно полтора абзаца.
// Это ровно то, что ищет пользователь по запросу «книга на английском с
// переводом», и обрывалось оно на середине первой сцены. Ограничение поднято до
// полноценного фрагмента: столько же, сколько даёт «просмотр отрывка» в
// книжном магазине, и достаточно, чтобы страница отвечала на запрос, а не
// дразнила им. Оригиналы 95 из 111 книг сайта — public domain, перевод наш.
const MAX_SENTENCES = 60;
const MAX_EN_WORDS = 650;
const MIN_EN_LEN = 25; // первая «настоящая» фраза не короче (отсекаем заголовок главы)

const wordCount = s => (s.match(/\S+/g) || []).length;

// 1. Книги сайта: image_url -> { slug, mode }
const siteBooks = JSON.parse(readFileSync(join(ROOT, 'src/data/books.json'), 'utf8'))
  .filter(b => !b.title.includes('Guide') && !b.title.includes('Руководство'));
const metaByImg = siteBooksByImage(siteBooks);

// 2. Тянем из БД предложения первой главы (с фразами) каждой переведённой книги.
//    text/translatedText и phrase.original/translated — в original_language/translated_language.
const rows = psqlJson(`
  SELECT COALESCE(json_agg(j), '[]'::json) FROM (
    SELECT b.image_url AS img,
           b.original_language AS lang,
           b.pages_count AS pages,
           (SELECT count(*) FROM chapters WHERE book_id = b.id) AS chapters,
           b.year_published AS year,
           -- Русские title/описание. В БД метаданные лежат парой «оригинал /
           -- перевод», и русская сторона зависит от языка оригинала: у русских
           -- книг это metadata_original, у английских — metadata_translated.
           CASE WHEN b.original_language = 'RUSSIAN'
                THEN b.metadata_original ELSE b.metadata_translated END AS meta_ru,
           ( SELECT json_agg(
               jsonb_build_object('ch', c.order_id, 't', s.value->>'text',
                                  'tt', s.value->>'translatedText', 'ph', s.value->'phrases')
               ORDER BY c.order_id, p.pord, (s.value->>'orderId')::int
             )
             FROM chapters c
             CROSS JOIN LATERAL jsonb_array_elements(c.paragraphs) WITH ORDINALITY p(value, pord)
             CROSS JOIN LATERAL jsonb_array_elements(p.value->'sentences') s(value)
             WHERE c.book_id = b.id
               -- Несколько первых глав, а не только самая первая. У части книг
               -- нулевая глава — титульный лист на пару предложений: отрывок из
               -- неё выходил в 11 слов, а у «Little Lady of the Big House» не
               -- получался вовсе. Нужную главу выбирает уже JS.
               AND c.order_id < (SELECT min(order_id) FROM chapters WHERE book_id = b.id) + 6
               -- запас абзацев: лимит по словам применяется уже в JS, а короткие
               -- абзацы диалогов дают мало текста при большом их числе
               AND p.pord <= 120
           ) AS sents,
           b.status
    FROM books b
    -- Непереведённые книги тоже выгружаем — не ради отрывка, а ради статуса:
    -- по нему каталог сайта их отбрасывает. Читать их в приложении нельзя, и
    -- страница, обещающая чтение с переводом, обещала бы несуществующее.
  ) j
`);

// 3. Собираем excerpts.json, book-stats.json (страницы, главы) и book-meta.json
//    (русское описание, год издания).
const excerpts = {};
const stats = {};
const meta = {};
let matched = 0;
for (const row of rows || []) {
  const site = metaByImg.get(normUrl(row.img));
  if (!site) continue;
  const fromEnglish = row.lang === 'ENGLISH';

  // Реальная статистика — для всех совпавших книг (даже без отрывка)
  const pages = Number(row.pages) || 0;
  const chapters = Number(row.chapters) || 0;
  if (pages || chapters) stats[site.slug] = { pages, chapters };

  // Русское описание есть в БД у всех книг, тогда как в books.json у 60 из 111
  // записей синопсис английский. Год издания заполнен на 100% — он идёт и в
  // факты страницы, и в datePublished схемы Book.
  const ru = row.meta_ru || {};
  const year = /^\d{4}$/.test(String(row.year || '')) ? Number(row.year) : null;
  const description = (ru.description || '').trim();
  const short = (ru.shortDescription || '').trim();
  // Русское название книги. Нужно даже там, где запись в каталоге одна: у книг
  // в параллельном режиме она английская, и страница уходила в заголовок вида
  // «Great Expectations на английском» — при том, что ищут «Большие надежды».
  const title = (ru.title || '').trim();
  // Русское имя автора — по той же причине: у записей в параллельном режиме
  // author приходит латиницей («Charles Dickens» вместо «Чарльз Диккенс»).
  const author = (ru.author || '').trim();
  const translated = row.status === 'TRANSLATED';
  meta[site.slug] = {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(description ? { description } : {}),
    ...(short ? { short } : {}),
    ...(year ? { year } : {}),
    translated,
  };

  // Всё дальнейшее — про текст книги, которого у непереведённых записей нет.
  if (!translated || !Array.isArray(row.sents)) continue;

  // Главу отрывка выбираем по содержимому: у части книг нулевая глава — это
  // титульный лист или эпиграф на два предложения, и отрывок из неё получался
  // бессмысленно коротким. Берём первую главу, где есть о чём читать, а если
  // такой нет — самую содержательную из первых.
  const MIN_CHAPTER_SENTENCES = 8;
  const perChapter = new Map();
  for (const s of row.sents) {
    if (s) perChapter.set(s.ch, (perChapter.get(s.ch) || 0) + 1);
  }
  const chapterIds = [...perChapter.keys()].sort((a, b) => a - b);
  const startChapter =
    chapterIds.find(ch => perChapter.get(ch) >= MIN_CHAPTER_SENTENCES) ??
    [...chapterIds].sort((a, b) => perChapter.get(b) - perChapter.get(a))[0];
  const sourceSents = row.sents.filter(s => s && s.ch >= startChapter);

  const sentences = [];
  let enWords = 0;
  for (const s of sourceSents) {
    if (!s) continue;
    const ru = ((fromEnglish ? s.tt : s.t) || '').trim();
    const en = ((fromEnglish ? s.t : s.tt) || '').trim();
    if (!ru || !en) continue;
    if (sentences.length === 0 && en.length < MIN_EN_LEN) continue; // пропускаем заголовок

    // Пофразовая разбивка нужна только режиму погружения — по ней страница
    // вплетает английский в русский текст. Параллельный режим печатает
    // предложения целиком, и для него phrases — полтонны мёртвого груза в JSON.
    const phrases = site.mode === 'immersion' && Array.isArray(s.ph)
      ? s.ph
          .map(p => ({
            ru: ((fromEnglish ? p.translated : p.original) || '').trim(),
            en: ((fromEnglish ? p.original : p.translated) || '').trim(),
            cx: typeof p.complexity === 'number' ? p.complexity : 3,
          }))
          .filter(p => p.ru && p.en)
      : [];

    sentences.push({ en, ru, phrases });
    enWords += wordCount(en);
    if (sentences.length >= MAX_SENTENCES || enWords >= MAX_EN_WORDS) break;
  }

  if (sentences.length >= 2) {
    excerpts[site.slug] = { mode: site.mode, sentences };
    matched++;
  }
}

// 4. Размер каталога в самом приложении. На сайте лежит его подмножество (часть
//    книг ещё не заведена в books.json), поэтому страницы, обещающие «в
//    приложении книг больше», должны опираться на цифру из БД, а не на
//    захардкоженную. Раньше там стояло «100+ книг в 25 жанрах» — по книгам это
//    правда, по жанрам завышение почти на треть.
const appStats = psqlJson(`
  SELECT json_build_object(
    'books', (SELECT count(*) FROM books
              WHERE status = 'TRANSLATED' AND accessibility = 'PUBLIC' AND demo = false),
    'genres', (SELECT count(DISTINCT trim(g)) FROM books,
                 LATERAL unnest(string_to_array(genres, ',')) g
               WHERE status = 'TRANSLATED' AND accessibility = 'PUBLIC' AND demo = false
                 AND trim(g) <> '')
  )
`);
writeFileSync(join(ROOT, 'src/data/app-catalog.json'), JSON.stringify(appStats) + '\n');

writeFileSync(join(ROOT, 'src/data/excerpts.json'), JSON.stringify(excerpts) + '\n');
writeFileSync(join(ROOT, 'src/data/book-stats.json'), JSON.stringify(stats) + '\n');
writeFileSync(join(ROOT, 'src/data/book-meta.json'), JSON.stringify(meta) + '\n');

const sz = (JSON.stringify(excerpts).length / 1024).toFixed(0);
const words = Object.values(excerpts)
  .reduce((n, e) => n + e.sentences.reduce((m, s) => m + wordCount(s.en), 0), 0);
const avg = matched ? Math.round(words / matched) : 0;
console.log(`Отрывки: ${matched} шт., в среднем ${avg} английских слов (${sz} KB).`);
console.log(`Статистика: ${Object.keys(stats).length} записей. Метаданные: ${Object.keys(meta).length} записей.`);
console.log(`Всего книг сайта: ${siteBooks.length}.`);
