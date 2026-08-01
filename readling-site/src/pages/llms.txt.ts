/**
 * llms.txt — справка о сайте для AI-краулеров.
 *
 * Раньше лежал статикой в public/ и разошёлся с каталогом: обещал «25 genres,
 * 100+ books» при 16 жанрах и 83 книгах. Файл читают именно те краулеры, что
 * потом пересказывают Readling пользователю, поэтому завышенные числа в нём
 * вреднее, чем их отсутствие.
 *
 * Теперь всё, что можно посчитать, считается из каталога на сборке. Разойтись
 * с реальностью файл больше не может: чтобы цифра в нём изменилась, должен
 * измениться сам каталог.
 */
import type { APIRoute } from 'astro';

import { indexableCatalog, LEVEL_ORDER, MIN_BOOKS_TO_INDEX } from '../utils/catalog';
import { genreLabels, levelDescriptions } from '../utils/slug';

const SITE = 'https://readling.club';

/**
 * Точных счётчиков в файле нет намеренно. «83 books» устаревает от каждой
 * добавленной книги, «1 books» на уровне A1 читается как поломка, а жанр с
 * единственной книгой не стоит и упоминания. Округление вниз до десятка даёт
 * утверждение, которое остаётся верным, пока каталог не уменьшится вдвое.
 */
const roundedDown = (n: number) => `${Math.floor(n / 10) * 10}+`;

/**
 * Сколько книг должно быть у жанра, чтобы называть его в справке. Жанр с парой
 * книг создаёт у краулера ожидание раздела, которого на сайте нет.
 */
const MIN_BOOKS_PER_GENRE = 5;

export const GET: APIRoute = () => {
  const books = indexableCatalog;

  // Перечисляем только то, что реально представлено книгами: жанр без книг не
  // стоит упоминать, даже если он есть в справочнике.
  const genreCounts = new Map<string, number>();
  for (const book of books) {
    for (const genre of book.genres) {
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    }
  }
  const genres = [...genreCounts.entries()]
    .filter(([, count]) => count >= MIN_BOOKS_PER_GENRE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code]) => genreLabels[code] ?? code);

  // Уровни, чьи страницы сайт сам отдаёт в индекс: рекомендовать краулеру
  // страницу, закрытую noindex, — противоречивый сигнал.
  const levels = LEVEL_ORDER.filter(
    level => books.filter(b => b.level === level).length >= MIN_BOOKS_TO_INDEX,
  );
  const levelLines = levels.map(level => {
    const short = levelDescriptions[level.toLowerCase()]?.short ?? '';
    return `- ${level}${short ? ` (${short})` : ''} — ${SITE}/uroven/${level.toLowerCase()}/`;
  });

  // Замеры по полным текстам — то, чего нет больше нигде. Для AI-краулера это
  // самая ценная часть файла: остальное он выведет и из обычных страниц.
  const lexicons = books.map(b => b.lexicon).filter(Boolean) as NonNullable<
    (typeof books)[number]['lexicon']
  >[];
  const millionWords = Math.floor(lexicons.reduce((sum, l) => sum + l.words, 0) / 1_000_000);
  const rareShares = lexicons.map(l => l.rare['2000'] ?? 0).sort((a, b) => a - b);

  const text = `# Readling
> Mobile app for learning English through reading real books with gradual immersion

## About
Readling is a mobile app (iOS & Android) that helps Russian speakers learn English by
reading real books. Its unique "immersion mode" gradually weaves English phrases into
Russian text, increasing the English percentage with each page.

## Key Features
- Immersion mode: English gradually replaces Russian text as you read
- Parallel reading: side-by-side English and Russian translation
- 3 training types: flash cards, sentence puzzles, fill-in-the-word
- Book catalog: ${roundedDown(books.length)} classic books, CEFR levels ${levels[0]}–${levels[levels.length - 1]}
- Personal dictionary: auto-saved from reading, used in training
- Daily reading streaks for motivation

## How Immersion Mode Works
1. Start: Text is 90-95% Russian with a few English words (the, said, morning)
2. Middle: 30-50% English — you read simple phrases without thinking
3. Advanced: 60-80% English — only complex words remain in Russian
4. Final: 90-100% English — you read freely in English

## Catalog
Classic literature, each book available in immersion mode, parallel reading mode, or both.
Every book page carries a real bilingual excerpt from that book — the opening pages in the
same form they appear in the app.

### By CEFR level
${levelLines.join('\n')}

### By genre
${genres.join(', ')}

## Book Difficulty Data
Difficulty is measured, not estimated. Every book is analysed in full — over
${millionWords} million words of aligned bilingual text — and each book page reports its
own measurements:
- total words and distinct word forms
- share of vocabulary outside the 2000 most frequent English words
  (across the catalog this ranges from ${rareShares[0]}% to ${rareShares[rareShares.length - 1]}%)
- share of phrases rated simple, which are the first to switch to English
  in immersion mode
The Russian translations are Readling's own, so this data exists nowhere else.

## Target Audience
- Russian speakers learning English, from ${levels[0]} to ${levels[levels.length - 1]}
- People who love reading and want to combine hobby with learning
- Users looking for alternatives to exercise-based apps like Duolingo

## Pricing
- Free tier: limited book catalog
- Subscription: $3.99/month — all books, no ads, all features
- 7-day free trial, no auto-charge afterwards

## Links
- Website: ${SITE}
- Book catalog: ${SITE}/books/
- Immersion Method: ${SITE}/metod-pogruzheniya/
- Parallel Reading: ${SITE}/parallelnoe-chtenie/
- Pricing: ${SITE}/pricing/
- Readling vs Duolingo: ${SITE}/sravnenie/readling-vs-duolingo/
- About: ${SITE}/o-readling/
- Sitemap: ${SITE}/sitemap-index.xml
`;

  return new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
