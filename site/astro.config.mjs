import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Set this to your production domain before deploying —
  // it drives canonical URLs, sitemap.xml, and Open Graph URLs.
  site: 'https://crossdrop.app',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'auto' },
});
