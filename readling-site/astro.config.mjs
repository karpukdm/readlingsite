// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://app.readling.club',
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    sitemap({
      changefreq: 'weekly',
      priority: 0.5,
      lastmod: new Date(),
      serialize(item) {
        const url = item.url;

        // Главная — высший приоритет, обновляется еженедельно
        if (/\/$/.test(url) && url.replace(/\/$/, '') === 'https://app.readling.club') {
          return { ...item, priority: 1.0, changefreq: 'weekly' };
        }

        // Тематические лендинги (метод, параллельное чтение, цены, сравнения) — высокий приоритет
        if (/\/(metod-pogruzheniya|parallelnoe-chtenie|pricing|sravnenie)\//.test(url)) {
          return { ...item, priority: 0.9, changefreq: 'monthly' };
        }

        // Каталог книг
        if (/\/books\/$/.test(url)) {
          return { ...item, priority: 0.9, changefreq: 'weekly' };
        }

        // Страницы отдельных книг — средний приоритет
        if (/\/books\/[^/]+\/$/.test(url)) {
          return { ...item, priority: 0.6, changefreq: 'monthly' };
        }

        return { ...item, priority: 0.5, changefreq: 'monthly' };
      },
    }),
  ],
  build: {
    assets: '_assets',
  },
});
