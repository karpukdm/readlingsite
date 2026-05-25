// Даты страниц для Article schema.
//
// Раньше пробовали тянуть даты через `git log` (execFileSync),
// но это ломает билд на Cloudflare Pages (shallow clone / нет git binary).
// Безопасный фолбэк: используем дату текущей сборки.
// Это правдиво (страница действительно собрана сегодня), и не ломает рендер.

const BUILD_TIME = new Date().toISOString();

// Если хотите задать ручные даты создания страниц — добавьте сюда.
// Иначе по умолчанию используется BUILD_TIME.
const MANUAL_DATES: Record<string, { datePublished?: string; dateModified?: string }> = {
  'src/pages/metod-pogruzheniya.astro': { datePublished: '2026-03-15T00:00:00Z' },
  'src/pages/parallelnoe-chtenie.astro': { datePublished: '2026-03-15T00:00:00Z' },
  'src/pages/sravnenie/readling-vs-duolingo.astro': { datePublished: '2026-03-15T00:00:00Z' },
  'src/pages/o-readling.astro': { datePublished: '2026-05-25T00:00:00Z' },
};

export function getPageDates(relPath: string): { datePublished: string; dateModified: string } {
  const manual = MANUAL_DATES[relPath] || {};
  return {
    datePublished: manual.datePublished || BUILD_TIME,
    dateModified: manual.dateModified || BUILD_TIME,
  };
}
