// Лексический портрет книги: измеренная статистика текста и словарь ключевых слов.
//
// Зачем: страница книги пересказывала то, что и так есть на десятке сайтов —
// автор, жанр, синопсис, уровень CEFR. Уровень при этом просто заявлялся числом.
// Здесь он обосновывается замерами по полному тексту, а словарь показывает, какую
// именно лексику читатель встретит. Ни того, ни другого нет ни у кого, кроме нас:
// исходник — выровненный двуязычный текст из БД приложения.
//
// Требует таблиц, которые готовит prepare-corpus.mjs (они тяжёлые, поэтому
// считаются один раз и переиспользуются):
//   tmp_sents     — все предложения всех книг, английская и русская сторона
//   tmp_wordfreq2 — частота слов по книгам + сколько раз слово шло с заглавной
//   tmp_wordtr    — перевод слова, взятый из однословных фраз выравнивания
//
// Запуск:
//   node scripts/prepare-corpus.mjs   (один раз, ~8 минут)
//   node scripts/export-lexicon.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, psqlJson, normUrl, siteBooksByImage } from './lib/db.mjs';

// Сколько слов показываем в словаре книги.
const VOCAB_SIZE = 40;

// Слово считаем именем собственным, если по всему корпусу оно почти всегда идёт
// с заглавной. Порог именно корпусный, а не внутрикнижный: внутри одной книги
// заглавными оказываются и обычные слова, просто стоящие в начале предложения
// («Yes» — 84% в «1984»), а на 19 млн слов эта позиционная случайность
// усредняется и остаются настоящие имена (winston, oceania — 100%).
const PROPER_NOUN_RATIO = 0.9;

// Какую долю вхождений слово должно отработать в одиночку, чтобы показывать его
// перевод. Отсекает слова, живущие внутри устойчивых сочетаний.
const MIN_STANDALONE_SHARE = 0.25;

// Предел длины перевода. Выравнивание иногда вешает на одно английское слово
// целую русскую фразу («singly → если будут держаться порознь»): в тексте это
// верно, но как словарная статья бессмысленно. Порог подобран так, чтобы
// нормальные многословные переводы («шнурки для ботинок», «в конце концов»)
// остались, а куски предложений ушли.
const MAX_TRANSLATION_LEN = 24;

// Первые N самых частотных слов корпуса — служебная и базовая лексика. В словарь
// книги они не попадают: «the», «said», «went» никого не научат.
const COMMON_WORDS = 2000;

// Пороги «редкой» лексики для статистики: доля вхождений вне топ-2000 и топ-5000
// корпуса. Это и есть измеримое обоснование уровня CEFR.
const RARE_THRESHOLDS = [2000, 5000];

console.log('Читаю корпус…');

// Частота слова по всему корпусу: сколько раз встретилось, сколько раз с
// заглавной и в скольких книгах. Порог 3 отсекает опечатки и артефакты OCR.
const corpus = psqlJson(`
  SELECT COALESCE(json_agg(x), '[]'::json) FROM (
    SELECT word, sum(n)::int AS tot, sum(cap_n)::int AS cap, count(*)::int AS df
    FROM tmp_wordfreq2
    GROUP BY word
    HAVING sum(n) >= 3
    ORDER BY sum(n) DESC
  ) x
`) || [];

// Ранг слова по частоте в корпусе: 0 — самое частотное.
const rank = new Map();
const isProperNoun = new Map();
corpus.forEach((w, i) => {
  rank.set(w.word, i);
  isProperNoun.set(w.word, w.cap / w.tot >= PROPER_NOUN_RATIO);
});
// Обратная документная частота для TF-IDF: слово, встречающееся во всех книгах,
// ничего не говорит о конкретной.
const booksInCorpus = psqlJson('SELECT count(DISTINCT book_id) FROM tmp_wordfreq2') || 1;
const idf = new Map(corpus.map(w => [w.word, Math.log(booksInCorpus / w.df)]));

console.log(`  словарь корпуса: ${corpus.length} слов, из них имён собственных: ${[...isProperNoun.values()].filter(Boolean).length}`);

console.log('Читаю статистику книг…');

// Объём и длина предложения. Слова считаем по пробелам — для прозы этого
// достаточно, а regexp по 1.4 млн предложений заметно дороже.
const sizes = psqlJson(`
  SELECT COALESCE(json_agg(x), '[]'::json) FROM (
    SELECT s.book_id,
           count(*)::int AS sentences,
           sum(length(s.en) - length(replace(s.en, ' ', '')) + 1)::int AS words,
           -- Уникальные словоформы считаем по всей таблице частот, без порога:
           -- порог n >= 3 ниже нужен словарю, а «богатство лексики» он бы занизил.
           (SELECT count(*)::int FROM tmp_wordfreq2 f WHERE f.book_id = s.book_id) AS distinct_words
    FROM tmp_sents s
    WHERE s.en IS NOT NULL AND s.en <> ''
    GROUP BY s.book_id
  ) x
`) || [];

console.log('Читаю распределение сложности фраз…');

// Оценка сложности каждой фразы — её ставит само приложение при выравнивании.
const complexity = psqlJson(`
  SELECT COALESCE(json_agg(x), '[]'::json) FROM (
    SELECT book_id, (p->>'complexity')::int AS cx, count(*)::int AS n
    FROM tmp_sents, LATERAL jsonb_array_elements(ph) p
    WHERE p->>'complexity' IS NOT NULL
    GROUP BY 1, 2
  ) x
`) || [];

console.log('Читаю частоты слов по книгам…');

const perBook = psqlJson(`
  SELECT COALESCE(json_agg(x), '[]'::json) FROM (
    SELECT f.book_id, f.word, f.n, f.cap_n, t.translated, t.n AS tr_n
    FROM tmp_wordfreq2 f
    LEFT JOIN tmp_wordtr t ON t.book_id = f.book_id AND t.word = f.word
    WHERE f.n >= 3
  ) x
`) || [];

console.log('Сопоставляю с каталогом сайта…');

const ids = psqlJson(`
  SELECT COALESCE(json_agg(json_build_object('id', id, 'img', image_url)), '[]'::json)
  FROM books WHERE status = 'TRANSLATED'
`) || [];

const siteBooks = JSON.parse(readFileSync(join(ROOT, 'src/data/books.json'), 'utf8'));
const metaByImg = siteBooksByImage(siteBooks);
const slugById = new Map();
for (const row of ids) {
  const site = metaByImg.get(normUrl(row.img));
  if (site) slugById.set(row.id, site.slug);
}

// --- Сборка ---

const sizeById = new Map(sizes.map(s => [s.book_id, s]));

const cxById = new Map();
for (const row of complexity) {
  const dist = cxById.get(row.book_id) || {};
  dist[row.cx] = (dist[row.cx] || 0) + row.n;
  cxById.set(row.book_id, dist);
}

const wordsById = new Map();
for (const row of perBook) {
  const list = wordsById.get(row.book_id);
  if (list) list.push(row);
  else wordsById.set(row.book_id, [row]);
}

const out = {};
for (const [bookId, slug] of slugById) {
  const size = sizeById.get(bookId);
  const words = wordsById.get(bookId) || [];
  if (!size || !words.length) continue;

  // Доля редкой лексики: считаем по вхождениям, а не по уникальным словам, —
  // читателю важно, как часто он будет спотыкаться, а не сколько редких слов
  // есть в книге теоретически.
  const totalOccurrences = words.reduce((n, w) => n + w.n, 0);
  const rare = {};
  for (const threshold of RARE_THRESHOLDS) {
    const beyond = words
      .filter(w => !isProperNoun.get(w.word) && (rank.get(w.word) ?? Infinity) >= threshold)
      .reduce((n, w) => n + w.n, 0);
    rare[threshold] = Math.round((beyond / totalOccurrences) * 1000) / 10;
  }

  const cx = cxById.get(bookId) || {};
  const cxTotal = Object.values(cx).reduce((a, b) => a + b, 0) || 1;

  // Словарь книги: слово характерно для неё, если часто здесь и редко вообще.
  // Имена собственные и базовую лексику выкидываем — учить в них нечего.
  const vocabulary = words
    .filter(w =>
      w.translated &&
      w.translated.length <= MAX_TRANSLATION_LEN &&
      !isProperNoun.get(w.word) &&
      // Имя персонажа корпусный фильтр не ловит, если то же слово где-то ещё
      // работает нарицательным («Parsons» в «1984», «Flask» в «Моби Дике»,
      // «Beryl» у Конан Дойла). Внутри своей книги такое слово идёт с заглавной
      // практически всегда — это и отсеиваем.
      w.cap_n / w.n < PROPER_NOUN_RATIO &&
      // Перевод должен отражать то, как слово реально употребляется в книге.
      // «sperm» в «Моби Дике» почти всегда часть «sperm whale» (кашалот), и
      // отдельный перевод одиночного слова вводил бы в заблуждение. Требуем,
      // чтобы слово встречалось самостоятельно в заметной доле вхождений.
      (w.tr_n ?? 0) / w.n >= MIN_STANDALONE_SHARE &&
      (rank.get(w.word) ?? Infinity) >= COMMON_WORDS &&
      w.word.length > 2 &&
      !w.word.includes("'"))
    .map(w => ({ ...w, score: w.n * (idf.get(w.word) ?? 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, VOCAB_SIZE)
    .map(w => ({ w: w.word, ru: w.translated, n: w.n }));

  out[slug] = {
    words: size.words,
    sentences: size.sentences,
    distinctWords: size.distinct_words,
    avgSentence: Math.round((size.words / size.sentences) * 10) / 10,
    rare,
    cx: Object.fromEntries(
      Object.entries(cx)
        .map(([k, v]) => [k, Math.round((v / cxTotal) * 1000) / 10])
        .sort(([a], [b]) => Number(a) - Number(b)),
    ),
    vocabulary,
  };
}

writeFileSync(join(ROOT, 'src/data/book-lexicon.json'), JSON.stringify(out) + '\n');

const entries = Object.values(out);
const avgVocab = entries.length
  ? Math.round(entries.reduce((n, e) => n + e.vocabulary.length, 0) / entries.length)
  : 0;
const size = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`\nГотово: ${entries.length} книг, в среднем ${avgVocab} слов в словаре (${size} KB).`);
console.log(`Без словаря: ${entries.filter(e => !e.vocabulary.length).length} книг.`);
