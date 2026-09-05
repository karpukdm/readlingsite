/**
 * Единый источник истины по каталогу книг на сайте.
 *
 * `books.json` — выгрузка из БД приложения, и она содержит две вещи, которые
 * нельзя отдавать в поиск как есть:
 *
 * 1. Одно произведение может лежать двумя записями — русской (режим погружения)
 *    и английской (параллельное чтение). До объединения это давало два URL под
 *    один и тот же запрос («Портрет Дориана Грея на английском» ↔
 *    «The Picture of Dorian Gray на английском») плюс противоречивые уровни
 *    CEFR у одной книги. Здесь такие записи сливаются в одну карточку с двумя
 *    отрывками, а retired-слуг уходит в 301 (см. book-redirects.json).
 *
 *    Канонической выбрана запись в параллельном режиме. Русское название при
 *    этом не теряется: оно едет в `russianTitle` и идёт первым в title/H1 —
 *    именно его ищут («Портрет Дориана Грея на английском»), а не английский
 *    оригинал.
 *
 * 2. Часть записей — артефакты Gutenberg-выгрузки («Volume 3 (of 3)»,
 *    «Complete Works», биография Брэдлафа). Спроса в русском поиске у них нет,
 *    страницы получаются чисто шаблонные и тянут вниз оценку всего /books/.
 *    Такие записи не попадают на сайт вовсе (EXCLUDED_SLUGS).
 *
 * Страницы без единого отрывка помечаются `noindex`: кроме описания на них нет
 * ничего, кроме шаблона. Они остаются доступны из каталога, но не идут в индекс
 * и не попадают в sitemap (фильтр — в astro.config.mjs, по факту наличия
 * noindex в собранном HTML).
 */
import allBooks from '../data/books.json';
import excerptData from '../data/excerpts.json';
import bookStatsData from '../data/book-stats.json';
import bookMetaData from '../data/book-meta.json';
import bookLexiconData from '../data/book-lexicon.json';
import appCatalogData from '../data/app-catalog.json';
import redirectMap from '../data/book-redirects.json';
import { toSlug, complexityToLevel } from './slug';

export type ExcerptPhrase = { ru: string; en: string; cx: number };
export type ExcerptSentence = { en: string; ru: string; phrases: ExcerptPhrase[] };
export type Excerpt = { mode: 'parallel' | 'immersion'; sentences: ExcerptSentence[] };

type RawBook = {
  title: string;
  author: string;
  complexity: number;
  description: string;
  image_url: string;
  genres: string;
  mode: string;
};

/** Объём книги в единицах выгрузки: «страница» — фиксированные ~341 слово. */
export type BookStat = { pages: number; chapters: number };

export type CatalogBook = {
  slug: string;
  /** Название канонической записи: у объединённых пар — английский оригинал. */
  title: string;
  /** Русское название произведения, если оно известно и отличается от `title`. */
  russianTitle: string | null;
  /** Название для читателя: русское, если есть. Им подписаны карточки и H1. */
  displayTitle: string;
  author: string;
  /** Имя автора для читателя: русское написание, если оно известно. */
  displayAuthor: string;
  /**
   * Все написания имени автора среди объединённых записей — «Oscar Wilde» и
   * «Оскар Уайльд» для одной и той же книги. По этому списку ищутся другие книги
   * автора: иначе после объединения английская запись перестала бы находить
   * русские книги того же автора.
   */
  authors: string[];
  /**
   * Канонический ключ автора, общий для всех написаний его имени. По нему
   * связываются книги одного автора и строятся страницы `/avtor/`.
   */
  authorKey: string;
  /** Уровень CEFR как число 1–6. У объединённых записей — минимальный из двух. */
  complexity: number;
  level: string;
  description: string;
  /**
   * Язык `description`. У параллельных записей в БД синопсис приходит
   * по-английски: на русской странице его нельзя ни отдавать в meta description,
   * ни выводить без `lang` — иначе страница заявляет один язык, а показывает другой.
   */
  descriptionLang: 'ru' | 'en';
  /** Короткий русский синопсис в одну фразу — для meta description. */
  shortDescription: string | null;
  /** Год первой публикации оригинала. Идёт в факты страницы и в datePublished. */
  year: number | null;
  genres: string[];
  /** Отрывок в режиме погружения — если книга доступна в этом режиме. */
  immersion: Excerpt | null;
  /** Отрывок в параллельном режиме — если книга доступна в этом режиме. */
  parallel: Excerpt | null;
  /** Режимы чтения, доступные в приложении. Минимум один. */
  modes: Array<'immersion' | 'parallel'>;
  /** Объём книги. У объединённых записей — из записи с большим числом страниц. */
  stat: BookStat | null;
  /** Замеры по полному тексту книги. Нет у книг, которых нет в БД приложения. */
  lexicon: BookLexicon | null;
  /** Ни одного отрывка нет — страница почти пустая, в индекс не отдаём. */
  noindex: boolean;
  /** Слуги, отдающие 301 на этот URL. */
  retiredSlugs: string[];
};

const excerpts = excerptData as Record<string, Excerpt>;
const bookStats = bookStatsData as Record<string, BookStat>;

/**
 * Русское описание и год издания из БД приложения. В `books.json` синопсис у 60
 * из 111 записей английский, и страница показывала его читателю как есть; в БД
 * же русское описание есть у всех книг, а год издания заполнен на 100%.
 */
type BookMeta = {
  title?: string;
  author?: string;
  description?: string;
  short?: string;
  year?: number;
  translated?: boolean;
};
const bookMeta = bookMetaData as Record<string, BookMeta>;

/** Слово словаря книги: английское слово, перевод и сколько раз встречается. */
export type VocabularyWord = { w: string; ru: string; n: number };

/**
 * Лексический портрет книги, посчитанный по её полному тексту
 * (scripts/export-lexicon.mjs). Это то, чего нет ни у кого, кроме нас: уровень
 * CEFR перестаёт быть заявленным числом и получает измеримое обоснование.
 */
export type BookLexicon = {
  /** Слов в книге и уникальных словоформ. */
  words: number;
  distinctWords: number;
  sentences: number;
  /** Средняя длина предложения в словах — по каталогу разброс от 6 до 35. */
  avgSentence: number;
  /** Доля вхождений вне N самых частотных слов корпуса, в процентах. */
  rare: Record<string, number>;
  /** Распределение фраз по сложности 1–6 в процентах — оценка приложения. */
  cx: Record<string, number>;
  /** Характерные слова книги с переводом. */
  vocabulary: VocabularyWord[];
};
const bookLexicon = bookLexiconData as Record<string, BookLexicon>;

/** retired-слуг → канонический слуг. Из него же генерируется dist/_redirects. */
export const BOOK_REDIRECTS: Record<string, string> = redirectMap;

/**
 * Артефакты Gutenberg-выгрузки: у этих записей нет ни поискового спроса на
 * русском, ни отрывка, а «Complete Works» и «Volume 3 (of 3)» — вообще не книга,
 * которую кто-то садится читать для практики языка.
 */
export const EXCLUDED_SLUGS = new Set([
  'charles-bradlaugh-a-record-of-his-life-and-work-volume-1',
  'hegel-s-lectures-on-the-history-of-philosophy-volume-3-of-3',
  'my-life-volume-1',
  'the-city-of-god-volume-i',
  'the-complete-works-of-william-shakespeare',
  'the-oriental-story-book-a-collection-of-tales-by-wilhelm-hauff',
]);

/** Служебные записи приложения — не книги. */
function isServiceEntry(title: string): boolean {
  return title.includes('Guide') || title.includes('Руководство');
}

/**
 * Написания имени одного автора, которые нельзя связать автоматически.
 *
 * Основную часть пар («Jack London» ↔ «Джек Лондон») даёт объединение карточек:
 * там английская и русская записи книги лежат в одной группе, и оба написания
 * автора видны рядом. Но у авторов, чьи книги в пары не объединялись, такой
 * подсказки нет — до нормализации «Charles Dickens» (5 книг) и «Чарльз Диккенс»
 * считались разными людьми, и блок «Другие книги автора» показывал не всё.
 *
 * Сопоставлять транслитерацией нельзя: проверка на этом каталоге даёт
 * «Александр Пушкин» ↔ «Charles Dickens» со сходством 0.88. Поэтому остаток —
 * явным списком. Незакрытые случаи ищет `unlinkedAuthorSpellings()`.
 */
const AUTHOR_ALIASES: string[][] = [
  ['Charles Dickens', 'Чарльз Диккенс'],
  ['Mark Twain', 'Марк Твен'],
  ['Lewis Carroll', 'Льюис Кэрролл'],
  // Соавторская запись «Двадцати лет спустя» — тот же Дюма в каталоге.
  ['Alexandre Dumas', 'Alexandre Dumas and Auguste Maquet'],
];

/**
 * Объединяет написания имени автора в классы эквивалентности и возвращает
 * «имя → канонический ключ». Канонический ключ — лексикографически первое имя
 * класса: он не зависит от порядка книг в выгрузке, поэтому URL страниц авторов
 * стабильны между сборками.
 */
function buildAuthorKeys(spellingGroups: string[][]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (name: string): string => {
    const up = parent.get(name);
    if (up === undefined || up === name) return name;
    const root = find(up);
    parent.set(name, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const group of spellingGroups) {
    for (const name of group) if (!parent.has(name)) parent.set(name, name);
    for (let i = 1; i < group.length; i++) union(group[0], group[i]);
  }

  // Канон класса — минимальное имя среди его членов.
  const members = new Map<string, string[]>();
  for (const name of parent.keys()) {
    const root = find(name);
    const list = members.get(root);
    if (list) list.push(name);
    else members.set(root, [name]);
  }

  const keys = new Map<string, string>();
  for (const list of members.values()) {
    const canonical = [...list].sort()[0];
    for (const name of list) keys.set(name, canonical);
  }
  return keys;
}

/** Текст русский, если кириллицы в нём заметно больше, чем случайных вкраплений. */
function isRussian(text: string): boolean {
  const cyrillic = (text.match(/[а-яё]/gi) || []).length;
  return cyrillic / Math.max(1, text.length) > 0.15;
}

/**
 * Убирает подзаголовок из длинных названий Gutenberg-выгрузки:
 * «The Importance of Being Earnest: A Trivial Comedy for Serious People» →
 * «The Importance of Being Earnest». Иначе title страницы выходит за 60 символов
 * и в выдаче обрезается на середине подзаголовка.
 *
 * Основную часть оставляем не короче 12 символов, чтобы не превратить название
 * в бессмысленный огрызок. Полное название сохраняется в `title`.
 */
const MAX_COMFORTABLE_TITLE = 40;
function stripSubtitle(title: string): string {
  if (title.length <= MAX_COMFORTABLE_TITLE) return title;
  const match = title.match(/^(.{12,}?)\s*[:;]\s+\S/);
  return match ? match[1].replace(/[,:;]\s*$/, '') : title;
}

/**
 * «Страница» в выгрузке — не полиграфическая, а фиксированная единица объёма:
 * по записям БД на неё приходится 319–387 слов, медиана 341. Полоса ниже вдвое
 * шире наблюдаемой — задача проверки поймать разъехавшиеся данные, а не
 * подогнать порог под текущий снимок каталога.
 */
const MIN_WORDS_PER_PAGE = 170;
const MAX_WORDS_PER_PAGE = 700;

type Measurements = {
  stat: BookStat | null;
  lexicon: BookLexicon | null;
};

/**
 * Сходятся ли между собой счётчик страниц и объём текста. Не сходятся — значит,
 * посчитаны по разным текстам, и верить нельзя как минимум счётчику страниц.
 */
function pagesMatchWords(stat: BookStat | null, lexicon: BookLexicon | null): boolean {
  if (!stat || !lexicon || stat.pages <= 0) return true;
  const wordsPerPage = lexicon.words / stat.pages;
  return wordsPerPage >= MIN_WORDS_PER_PAGE && wordsPerPage <= MAX_WORDS_PER_PAGE;
}

/**
 * Замеры одной записи БД — с проверкой на то, что они не противоречат друг другу.
 *
 * Числа со страницы книги проверяемы: объём и число глав любой классики есть в
 * Википедии. Значит, опубликованная ошибка — это не «неточность в данных», а
 * опровержение фразы «мы разобрали её полный текст» на той же странице. Дешевле
 * не показать замер, чем показать неверный.
 *
 * Обе проверки ловят противоречие внутри записи, а не «непохожесть на правду»:
 *
 * 1. Страниц меньше, чем глав. Так не бывает: значит, текст в БД короче самой
 *    книги, а объём и лексика посчитаны по обрезку. «Гиперболоид инженера
 *    Гарина» — 27 страниц при 38 главах и 10 415 словах, примерно десятая часть
 *    романа. Отбрасываем оба замера: они меряют не ту книгу, что на странице.
 *
 * 2. Слов на страницу вне полосы — `pages` и `words` посчитаны по разным
 *    текстам. «Алые паруса» — 256 страниц при 26 501 слове, то есть 104 слова
 *    на страницу против 341 по каталогу. Здесь ошибочен только счётчик страниц,
 *    поэтому лексику оставляем, а `stat` убираем: иначе страница обещает
 *    «256 страниц» у повести и отдаёт то же число в `numberOfPages` схемы.
 *
 * Чего эти проверки НЕ ловят: удвоенный текст (глава лежит в БД дважды). Там
 * все три числа растут согласованно и остаются внутренне непротиворечивыми —
 * см. `seo-strategy-review.md`, это чинится в выгрузке, а не здесь.
 */
function measurementsOf(recordSlug: string): Measurements {
  const stat = bookStats[recordSlug] ?? null;
  const lexicon = bookLexicon[recordSlug] ?? null;

  if (stat && stat.chapters > 0 && stat.pages < stat.chapters) {
    return { stat: null, lexicon: null };
  }

  if (!pagesMatchWords(stat, lexicon)) return { stat: null, lexicon };

  return { stat, lexicon };
}

/**
 * Карточки, у которых объём отброшен уже на уровне группы: записи по отдельности
 * были непротиворечивы, но ни одна не сошлась с выбранной лексикой. Заполняется
 * в `buildCatalog()` — иначе этот случай не попал бы в диагностику ниже и объём
 * исчезал бы со страницы молча.
 */
const cardsWithoutStat: string[] = [];

/**
 * Записи, чьи замеры не сходятся, и это уже разобрано: чинится не на сайте,
 * а в выгрузке из БД (см. `seo-strategy-review.md`, разделы 4 и 8). Пока слуг
 * в этом списке, сборка о нём не предупреждает.
 *
 * Список нужен именно ради предупреждения: без него в логе всегда висели бы две
 * известные строки, третья потерялась бы среди них, и сигнал о новой поломке
 * данных не отличался бы от фона.
 */
const KNOWN_INCONSISTENT = new Set([
  'giperboloid-inzhenera-garina',
  'alye-parusa',
]);

/**
 * Замеры, отброшенные проверками, — с указанием, что именно и у кого.
 * `unexpected` — то, чего нет в `KNOWN_INCONSISTENT`: новая поломка в данных.
 */
export function inconsistentMeasurements(): Array<{ slug: string; dropped: string; unexpected: boolean }> {
  const found: Array<{ slug: string; dropped: string; unexpected: boolean }> = [];
  const reported = new Set<string>();

  // Обе проверки уровня записи требуют `stat`, поэтому запись без него отбросить
  // нечего — ключей `bookStats` достаточно, объединять их с ключами лексики не нужно.
  for (const recordSlug of Object.keys(bookStats)) {
    const measured = measurementsOf(recordSlug);
    if (measured.stat) continue;
    const lostLexicon = Boolean(bookLexicon[recordSlug]) && !measured.lexicon;
    found.push({
      slug: recordSlug,
      dropped: lostLexicon ? 'объём и лексика' : 'объём',
      unexpected: !KNOWN_INCONSISTENT.has(recordSlug),
    });
    reported.add(recordSlug);
  }

  // Карточка из одной записи, у которой уже сообщили о поломке, — то же самое
  // событие, а не второе: в группе просто не осталось других кандидатов.
  // Сообщаем только там, где карточку сломало сочетание записей, а не запись.
  for (const slug of cardsWithoutStat) {
    if (reported.has(slug)) continue;
    found.push({
      slug,
      dropped: 'объём: ни одна запись группы не сошлась с лексикой',
      unexpected: !KNOWN_INCONSISTENT.has(slug),
    });
    reported.add(slug);
  }

  return found;
}

function buildCatalog(): CatalogBook[] {
  const raw = allBooks as RawBook[];

  // Канонический слуг для каждой записи: у retired-записей — слуг «выжившей».
  const canonicalSlugOf = (book: RawBook): string => {
    const slug = toSlug(book.title);
    return BOOK_REDIRECTS[slug] ?? slug;
  };

  const groups = new Map<string, RawBook[]>();
  for (const book of raw) {
    if (isServiceEntry(book.title)) continue;
    const slug = canonicalSlugOf(book);
    if (EXCLUDED_SLUGS.has(slug)) continue;
    const group = groups.get(slug);
    if (group) group.push(book);
    else groups.set(slug, [book]);
  }

  /**
   * Книги, которых в приложении ещё нет: в БД они лежат со статусом
   * NOT_TRANSLATED, то есть двуязычного текста для них не существует. Страница
   * такой книги обещала бы чтение с переводом, которого не будет, — поэтому
   * карточка не строится вовсе.
   *
   * Проверяем по всей группе, а не по отдельной записи: у объединённых пар
   * непереведённой часто оказывается одна сторона («Pride and Prejudice» при
   * переведённой «Гордости и предубеждении»), и книга при этом доступна.
   * Записи, которых в БД нет вообще, не трогаем — про них ничего не известно.
   */
  for (const [slug, group] of [...groups]) {
    const known = group.map(b => bookMeta[toSlug(b.title)]).filter(Boolean);
    if (known.length === group.length && known.every(m => m.translated === false)) {
      groups.delete(slug);
    }
  }

  // Написания имени автора, встреченные рядом в одной карточке, — это один
  // человек. Русское имя из метаданных БД идёт сюда же: оно связывает
  // «Charles Dickens» с «Чарльзом Диккенсом» даже там, где русской записи книги
  // в каталоге нет. К ним добавляем пары, которые так не выводятся вовсе.
  const authorKeys = buildAuthorKeys([
    ...[...groups.values()].map(g => [
      ...new Set([
        ...g.map(b => b.author),
        ...g.map(b => bookMeta[toSlug(b.title)]?.author),
      ].filter((a): a is string => Boolean(a))),
    ]),
    ...AUTHOR_ALIASES,
  ]);

  const catalog: CatalogBook[] = [];

  for (const [slug, group] of groups) {
    // Основная запись — та, чей слуг совпал с каноническим. Для объединённых пар
    // это запись в параллельном режиме: её описание и обложка идут на страницу.
    const primary = group.find(b => toSlug(b.title) === slug) ?? group[0];

    // Русское название. Нужно для title/H1: русский запрос по книге кратно
    // частотнее английского оригинала.
    //
    // Сначала ищем среди самих записей — у объединённых пар русская запись уже
    // лежит рядом. Если её нет (книга есть только в параллельном режиме, а таких
    // 38 из 83), берём название из метаданных БД: иначе страница уходила бы в
    // заголовок «Great Expectations на английском» вместо «Больших надежд».
    const metaTitles = group
      .map(b => bookMeta[toSlug(b.title)]?.title)
      .filter((t): t is string => Boolean(t) && /[а-яё]/i.test(t!));

    const russianTitle =
      group.map(b => b.title).find(t => t !== primary.title && /[а-яё]/i.test(t)) ??
      (/[а-яё]/i.test(primary.title) ? primary.title : null) ??
      metaTitles[0] ??
      null;

    const immersionSource = group.find(b => excerpts[toSlug(b.title)]?.mode === 'immersion');
    const parallelSource = group.find(b => excerpts[toSlug(b.title)]?.mode === 'parallel');

    const immersion = immersionSource ? excerpts[toSlug(immersionSource.title)] : null;
    const parallel = parallelSource ? excerpts[toSlug(parallelSource.title)] : null;

    // Режимы чтения берём из самих записей, а не из наличия отрывка: книга может
    // быть доступна в режиме, для которого отрывок ещё не выгружен.
    const modes: Array<'immersion' | 'parallel'> = [];
    if (group.some(b => b.mode !== 'параллельный')) modes.push('immersion');
    if (group.some(b => b.mode === 'параллельный')) modes.push('parallel');

    // Замеры берём только те, что прошли проверку на согласованность
    // (см. `measurementsOf`): противоречащие сами себе числа на страницу не идут.
    const measured = group.map(b => measurementsOf(toSlug(b.title)));

    // Лексика посчитана по записям БД, а карточка может объединять две из них
    // (русскую и английскую). Берём ту, где текст длиннее: у объединённых пар
    // это полная книга, а не сокращённая версия.
    const lexicon = measured
      .map(m => m.lexicon)
      .filter((l): l is BookLexicon => l !== null)
      .sort((a, b) => b.words - a.words)[0] ?? null;

    // Объём — из записи, где он известен и больше: у объединённых пар счётчик
    // страниц считался по разным изданиям, и заниженное число выглядит ошибкой.
    //
    // Но объём и лексика могут прийти из разных записей, и тогда они снова
    // расходятся, хотя внутри каждой записи сходились. Правило «побеждает
    // больший счётчик» тянет наверх как раз завышенный, поэтому берём не просто
    // максимум, а максимум из тех, что сходятся с выбранной лексикой: если
    // подходящая запись в группе есть, она лучше, чем карточка вообще без объёма.
    const statCandidates = measured
      .map(m => m.stat)
      .filter((s): s is BookStat => s !== null)
      .sort((a, b) => b.pages - a.pages);
    const stat = statCandidates.find(s => pagesMatchWords(s, lexicon)) ?? null;

    if (statCandidates.length && !stat) cardsWithoutStat.push(slug);

    // Уровень — минимальный из объединённых: страница предлагает оба режима, и
    // погружение (русская запись) — более доступный вход в ту же книгу.
    const complexity = Math.min(...group.map(b => b.complexity ?? 4));

    // Жанры объединяем: у русской и английской записи наборы иногда расходятся.
    const genres = [...new Set(group.flatMap(b => b.genres.split(',').map(g => g.trim()).filter(Boolean)))];

    // Все написания имени автора: из записей каталога плюс русское имя из
    // метаданных БД. Последнее — единственный источник для книг, которые есть
    // только в параллельном режиме: там author приходит латиницей.
    const metaAuthors = group
      .map(b => bookMeta[toSlug(b.title)]?.author)
      .filter((a): a is string => Boolean(a));
    const authors = [...new Set([...group.map(b => b.author), ...metaAuthors].filter(Boolean))];

    // Описание предпочитаем русское — даже если каноническая запись английская:
    // страница русская, и синопсис на ней должен быть на русском. Первым идёт
    // описание из БД: в books.json у многих записей синопсис только английский.
    const metas = group.map(b => bookMeta[toSlug(b.title)]).filter(Boolean);
    const description =
      metas.map(m => m?.description).find(d => d && isRussian(d)) ??
      group.map(b => b.description).find(d => d && isRussian(d)) ??
      primary.description ??
      '';
    const shortDescription = metas.map(m => m?.short).find(s => s && isRussian(s)) ?? null;

    // Год — минимальный среди объединённых записей: у пары «оригинал/перевод»
    // это год первой публикации произведения, а не конкретного издания.
    const years = metas.map(m => m?.year).filter((y): y is number => typeof y === 'number');
    const year = years.length ? Math.min(...years) : null;

    catalog.push({
      slug,
      title: primary.title,
      russianTitle: russianTitle === primary.title ? null : russianTitle,
      displayTitle: stripSubtitle(russianTitle ?? primary.title),
      author: primary.author,
      displayAuthor: authors.find(a => /[а-яё]/i.test(a)) ?? primary.author,
      authors,
      authorKey: authorKeys.get(primary.author) ?? primary.author,
      complexity,
      level: complexityToLevel[complexity] || 'B1',
      description,
      descriptionLang: isRussian(description) ? 'ru' : 'en',
      shortDescription,
      year,
      genres,
      immersion,
      parallel,
      modes: modes.length ? modes : ['immersion'],
      stat,
      lexicon,
      noindex: !immersion && !parallel,
      retiredSlugs: group.map(b => toSlug(b.title)).filter(s => s !== slug),
    });
  }

  return catalog.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Все книги, для которых собирается страница (включая noindex). */
export const catalog: CatalogBook[] = buildCatalog();

/** Книги, которые мы хотим видеть в индексе — для sitemap-подобных списков. */
export const indexableCatalog: CatalogBook[] = catalog.filter(b => !b.noindex);

/**
 * Сколько книг должно быть у подборки, чтобы её страница шла в индекс.
 *
 * Уровень с горсткой книг не выполняет обещание из H1 («Книги на английском
 * уровня A1») — такая страница читается как пустая и тянет вниз оценку раздела.
 *
 * Константа общая для страниц уровней и для llms.txt: иначе справка для
 * AI-краулеров рекомендовала бы страницу, которую сайт закрыл от индексации.
 */
export const MIN_BOOKS_TO_INDEX = 3;

/** Уровни CEFR по возрастанию — единый порядок для навигации и списков. */
export const LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/**
 * Размер каталога приложения — он больше сайтового: часть книг ещё не заведена
 * в `books.json`. Числа выгружаются из БД (scripts/export-excerpts.mjs).
 *
 * Округляем вниз до десятка. По страницам были рассыпаны «100+ книг в 25
 * жанрах»: по книгам это правда и сильно занижено, по жанрам — завышение почти
 * на треть. Округлённое утверждение остаётся верным, пока каталог не
 * уменьшится, и не требует правки от каждой добавленной книги.
 */
const roundDown = (n: number) => Math.floor(n / 10) * 10;

export const appCatalog = {
  /** «160+» — для фраз вида «в приложении 160+ книг». */
  books: `${roundDown(appCatalogData.books)}+`,
  /** Жанров округлять не нужно — их число меняется куда реже. */
  genres: appCatalogData.genres,
};

/** Сколько книг показывает сайт. Для фраз про каталог сайта, а не приложения. */
export const siteCatalogSize = indexableCatalog.length;

/**
 * Медианы по каталогу — точка отсчёта для чисел на странице книги. Само по себе
 * «средняя длина предложения 21 слово» читателю ничего не говорит; сравнение с
 * остальным каталогом (разброс от 6 до 35) превращает это в осмысленный факт.
 */
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const lexicons = catalog.map(b => b.lexicon).filter((l): l is BookLexicon => l !== null);

export const lexiconMedians = {
  rare2000: median(lexicons.map(l => l.rare['2000'] ?? 0)),
};

const bySlug = new Map(catalog.map(b => [b.slug, b]));

export function bookBySlug(slug: string): CatalogBook | undefined {
  return bySlug.get(slug);
}

/** Книги уровня, отсортированные так же, как в каталоге. */
export function booksByLevel(level: string): CatalogBook[] {
  const upper = level.toUpperCase();
  return catalog.filter(b => b.level === upper);
}

/**
 * Другие книги того же автора. Сверяем по каноническому ключу: сравнение по
 * строкам имени разводило «Charles Dickens» и «Чарльз Диккенс» по разным
 * авторам, и часть книг из блока пропадала.
 */
export function booksBySameAuthor(book: CatalogBook, limit = 4): CatalogBook[] {
  return catalog
    .filter(b => b.slug !== book.slug && b.authorKey === book.authorKey)
    .slice(0, limit);
}

/** Все книги автора по каноническому ключу — для страниц `/avtor/`. */
export function booksByAuthorKey(authorKey: string): CatalogBook[] {
  return catalog.filter(b => b.authorKey === authorKey);
}

/**
 * Авторы, у которых на сайте есть и кириллическое, и латинское написание имени,
 * не сведённые в один ключ. Пустой список — признак, что AUTHOR_ALIASES полон;
 * непустой печатается в сборку, чтобы новые книги не разводили автора надвое.
 */
export function unlinkedAuthorSpellings(): string[][] {
  const byKey = new Map<string, Set<string>>();
  for (const book of catalog) {
    const set = byKey.get(book.authorKey) ?? new Set<string>();
    for (const name of book.authors) set.add(name);
    byKey.set(book.authorKey, set);
  }

  const isCyrillic = (s: string) => /[а-яё]/i.test(s);
  const cyrillic = new Map<string, string[]>();
  const latin = new Map<string, string[]>();
  for (const [key, names] of byKey) {
    const target = [...names].some(isCyrillic) ? cyrillic : latin;
    target.set(key, [...names]);
  }

  // Пара считается упущенной, если совпадает набор согласных транслитерации:
  // этого мало для автоматической склейки, но достаточно, чтобы позвать глазами.
  const consonants = (s: string) =>
    [...new Set(s.toLowerCase().replace(/[^a-zа-яё]/gi, '').replace(/[aeiouyаеёиоуыэюя]/gi, ''))]
      .sort()
      .join('');

  const missed: string[][] = [];
  for (const [cyrKey] of cyrillic) {
    for (const [latKey] of latin) {
      if (consonants(cyrKey) && consonants(cyrKey) === consonants(latKey)) {
        missed.push([cyrKey, latKey]);
      }
    }
  }
  return missed;
}

/**
 * Диагностика выгрузки. В норме молчит: про уже разобранные записи знает
 * `KNOWN_INCONSISTENT`, про уже сведённых авторов — `AUTHOR_ALIASES`. Заговорила
 * — значит, в данных появилась новая поломка, и чинить её надо в БД, а не
 * привыкать к строчке в логе.
 *
 * Печатаем при загрузке модуля, а не из хука сборки: `astro.config.mjs` пришлось
 * бы переводить на `.ts` ради импорта отсюда, а модуль каталога и так
 * исполняется один раз за сборку (в dev — ещё раз на каждый HMR его данных).
 * До этого обе функции не вызывались ниоткуда, хотя комментарий у
 * `unlinkedAuthorSpellings()` обещал печать.
 */
const unexpectedlyDropped = inconsistentMeasurements().filter(d => d.unexpected);
if (unexpectedlyDropped.length) {
  console.warn(
    `[catalog] замеры не сошлись сами с собой, на страницы не пойдут — ${unexpectedlyDropped
      .map(d => `${d.slug} (${d.dropped})`)
      .join(', ')}. Если это известный дефект выгрузки, добавьте слуг в KNOWN_INCONSISTENT.`,
  );
}

const unlinkedAuthors = unlinkedAuthorSpellings();
if (unlinkedAuthors.length) {
  console.warn(
    `[catalog] возможно, один автор записан двумя именами — ${unlinkedAuthors
      .map(pair => pair.join(' ↔ '))
      .join('; ')}. Если это так, добавьте пару в AUTHOR_ALIASES.`,
  );
}
