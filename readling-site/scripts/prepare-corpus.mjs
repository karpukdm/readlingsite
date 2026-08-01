// Подготовка корпуса для export-lexicon.mjs.
//
// Тексты книг лежат в БД одним jsonb-полем на главу (chapters.paragraphs), и
// разворачивать его на каждый запрос слишком дорого: одна книга разворачивается
// ~16 секунд, весь каталог — почти полчаса. Поэтому корпус раскладывается в
// плоские таблицы один раз, а лексика считается уже по ним за секунды.
//
// Таблицы временные по смыслу, но не по типу: TEMP-таблицы живут только внутри
// сессии psql, а тут нужно пережить несколько запусков скриптов.
//
// Запуск (~8 минут, нужен поднятый контейнер translator-postgres-1):
//   node scripts/prepare-corpus.mjs

import { execFileSync } from 'node:child_process';

const CONTAINER = process.env.PG_CONTAINER || 'translator-postgres-1';
const DB_USER = process.env.PG_USER || 'user';
const DB_NAME = process.env.PG_DB || 'book_translator';

function psql(sql) {
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-c', sql], {
    stdio: 'inherit',
    maxBuffer: 1024 * 1024 * 1024,
  });
}

const steps = [
  [
    'tmp_sents — все предложения книг (английская и русская сторона)',
    `
    DROP TABLE IF EXISTS tmp_sents;
    CREATE TABLE tmp_sents AS
    SELECT b.id AS book_id,
           -- В БД пара «оригинал/перевод» ориентирована по языку книги, поэтому
           -- английская сторона лежит то в text, то в translatedText.
           CASE WHEN b.original_language = 'ENGLISH'
                THEN s.value->>'text' ELSE s.value->>'translatedText' END AS en,
           CASE WHEN b.original_language = 'ENGLISH'
                THEN s.value->>'translatedText' ELSE s.value->>'text' END AS ru,
           s.value->'phrases' AS ph,
           b.original_language AS lang
    FROM books b
    JOIN chapters c ON c.book_id = b.id
    CROSS JOIN LATERAL jsonb_array_elements(c.paragraphs) p(value)
    CROSS JOIN LATERAL jsonb_array_elements(p.value->'sentences') s(value)
    WHERE b.status = 'TRANSLATED';
    CREATE INDEX ON tmp_sents(book_id);
    `,
  ],
  [
    'tmp_wordfreq2 — частота слов по книгам + счётчик заглавных',
    `
    DROP TABLE IF EXISTS tmp_wordfreq2;
    CREATE TABLE tmp_wordfreq2 AS
    SELECT book_id,
           lower(w) AS word,
           count(*)::int AS n,
           -- по этому счётчику отсеиваются имена собственные
           count(*) FILTER (WHERE w ~ '^[A-Z]')::int AS cap_n
    FROM tmp_sents, LATERAL regexp_split_to_table(en, '[^A-Za-z'']+') w
    WHERE length(w) > 1
    GROUP BY book_id, lower(w);
    CREATE INDEX ON tmp_wordfreq2(book_id);
    CREATE INDEX ON tmp_wordfreq2(word);
    `,
  ],
  [
    'tmp_wordtr — перевод слова из однословных фраз выравнивания',
    `
    DROP TABLE IF EXISTS tmp_wordtr;
    CREATE TABLE tmp_wordtr AS
    SELECT book_id, word, translated, n FROM (
      SELECT s.book_id,
             lower(trim(both ' .,;:!?"' from
               CASE WHEN s.lang='ENGLISH' THEN p->>'original' ELSE p->>'translated' END)) AS word,
             lower(trim(both ' .,;:!?"' from
               CASE WHEN s.lang='ENGLISH' THEN p->>'translated' ELSE p->>'original' END)) AS translated,
             count(*)::int AS n,
             -- у слова оставляем самый частый его перевод в этой книге
             row_number() OVER (
               PARTITION BY s.book_id, lower(trim(both ' .,;:!?"' from
                 CASE WHEN s.lang='ENGLISH' THEN p->>'original' ELSE p->>'translated' END))
               ORDER BY count(*) DESC) AS rk
      FROM tmp_sents s CROSS JOIN LATERAL jsonb_array_elements(s.ph) p
      GROUP BY 1, 2, 3
    ) q
    WHERE rk = 1 AND length(word) > 1
      AND word ~ '^[a-z''-]+$'    -- английская сторона: ровно одно слово латиницей
      AND translated ~ '[а-яё]';  -- русская сторона непустая
    CREATE INDEX ON tmp_wordtr(book_id, word);
    `,
  ],
];

for (const [title, sql] of steps) {
  console.log(`\n=== ${title} ===`);
  const started = process.hrtime.bigint();
  psql(sql);
  const sec = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`   готово за ${sec.toFixed(0)} с`);
}

console.log('\nКорпус готов. Дальше: node scripts/export-lexicon.mjs');
