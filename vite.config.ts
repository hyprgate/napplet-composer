import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig({
  base: './',
  plugins: [
    svelte(),
    nip5aManifest({
      nappletType: 'compose',
      requires: ['identity', 'relay', 'outbox', 'storage', 'theme', 'resource', 'cvm', 'upload'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'composer', convention: 'napplet:composer/open' }],
    }),
  ],
  resolve: { dedupe: ['svelte'] },
  server: { port: 9511, cors: true },
  build: { outDir: 'dist' },
});
