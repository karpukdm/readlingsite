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
  genres: string[];
  /** Отрывок в режиме погружения — если книга доступна в этом режиме. */
  immersion: Excerpt | null;
  /** Отрывок в параллельном режиме — если книга доступна в этом режиме. */
  parallel: Excerpt | null;
  /** Режимы чтения, доступные в приложении. Минимум один. */
  modes: Array<'immersion' | 'parallel'>;
  /** Объём книги. У объединённых записей — из записи с большим числом страниц. */
  stat: { pages: number; chapters: number } | null;
  /** Ни одного отрывка нет — страница почти пустая, в индекс не отдаём. */
  noindex: boolean;
  /** Слуги, отдающие 301 на этот URL. */
  retiredSlugs: string[];
};

const excerpts = excerptData as Record<string, Excerpt>;
const bookStats = bookStatsData as Record<string, { pages: number; chapters: number }>;

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

  const catalog: CatalogBook[] = [];

  for (const [slug, group] of groups) {
    // Основная запись — та, чей слуг совпал с каноническим. Для объединённых пар
    // это запись в параллельном режиме: её описание и обложка идут на страницу.
    const primary = group.find(b => toSlug(b.title) === slug) ?? group[0];

    // Русское название — со второй записи пары. Нужно для title/H1: русский
    // запрос по книге кратно частотнее английского оригинала.
    const russianTitle =
      group.map(b => b.title).find(t => t !== primary.title && /[а-яё]/i.test(t)) ??
      (/[а-яё]/i.test(primary.title) ? primary.title : null);

    const immersionSource = group.find(b => excerpts[toSlug(b.title)]?.mode === 'immersion');
    const parallelSource = group.find(b => excerpts[toSlug(b.title)]?.mode === 'parallel');

    const immersion = immersionSource ? excerpts[toSlug(immersionSource.title)] : null;
    const parallel = parallelSource ? excerpts[toSlug(parallelSource.title)] : null;

    // Режимы чтения берём из самих записей, а не из наличия отрывка: книга может
    // быть доступна в режиме, для которого отрывок ещё не выгружен.
    const modes: Array<'immersion' | 'parallel'> = [];
    if (group.some(b => b.mode !== 'параллельный')) modes.push('immersion');
    if (group.some(b => b.mode === 'параллельный')) modes.push('parallel');

    // Объём — из записи, где он известен и больше: у объединённых пар счётчик
    // страниц считался по разным изданиям, и заниженное число выглядит ошибкой.
    const stat = group
      .map(b => bookStats[toSlug(b.title)])
      .filter(Boolean)
      .sort((a, b) => b.pages - a.pages)[0] ?? null;

    // Уровень — минимальный из объединённых: страница предлагает оба режима, и
    // погружение (русская запись) — более доступный вход в ту же книгу.
    const complexity = Math.min(...group.map(b => b.complexity ?? 4));

    // Жанры объединяем: у русской и английской записи наборы иногда расходятся.
    const genres = [...new Set(group.flatMap(b => b.genres.split(',').map(g => g.trim()).filter(Boolean)))];

    const authors = [...new Set(group.map(b => b.author).filter(Boolean))];

    // Описание предпочитаем русское — даже если каноническая запись английская:
    // страница русская, и синопсис на ней должен быть на русском.
    const description =
      group.map(b => b.description).find(d => d && isRussian(d)) ?? primary.description ?? '';

    catalog.push({
      slug,
      title: primary.title,
      russianTitle: russianTitle === primary.title ? null : russianTitle,
      displayTitle: stripSubtitle(russianTitle ?? primary.title),
      author: primary.author,
      displayAuthor: authors.find(a => /[а-яё]/i.test(a)) ?? primary.author,
      authors,
      complexity,
      level: complexityToLevel[complexity] || 'B1',
      description,
      descriptionLang: isRussian(description) ? 'ru' : 'en',
      genres,
      immersion,
      parallel,
      modes: modes.length ? modes : ['immersion'],
      stat,
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
 * Другие книги того же автора. Сверяем по всем написаниям имени, чтобы
 * английская запись находила русские книги автора и наоборот.
 */
export function booksBySameAuthor(book: CatalogBook, limit = 4): CatalogBook[] {
  const names = new Set(book.authors);
  return catalog
    .filter(b => b.slug !== book.slug && b.authors.some(a => names.has(a)))
    .slice(0, limit);
}
