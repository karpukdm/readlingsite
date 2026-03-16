// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://app.readling.club',
  output: 'static',
  integrations: [sitemap()],
  build: {
    assets: '_assets',
  },
});
