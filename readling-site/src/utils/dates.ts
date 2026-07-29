// Даты страниц для Article schema.
//
// datePublished задаётся вручную ниже — это дата создания материала.
//
// dateModified в проде рендерится как токен-заглушка, а реальную дату
// подставляет хук astro:build:done (см. lastmodTracker в astro.config.mjs):
// она вычисляется по факту изменения HTML и совпадает с lastmod в sitemap.
// Раньше здесь стояло время сборки, из-за чего dateModified обновлялся
// на всех страницах при каждом деплое.

const BUILD_TIME = new Date().toISOString();

// Должно совпадать с LASTMOD_TOKEN в astro.config.mjs.
const LASTMOD_TOKEN = '__LASTMOD_PLACEHOLDER__';

// В dev хука сборки нет, поэтому там показываем текущее время —
// иначе токен утёк бы в разметку и сломал JSON-LD.
const DATE_MODIFIED = import.meta.env.PROD ? LASTMOD_TOKEN : BUILD_TIME;

// Если хотите задать ручные даты создания страниц — добавьте сюда.
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
    dateModified: manual.dateModified || DATE_MODIFIED,
  };
}
