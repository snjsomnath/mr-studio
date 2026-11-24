import { defineConfig } from 'vite';

// The join page (#275) is published to GitHub Pages under /<repo>/v<LINK_VERSION>/, so every
// address in it is relative.
export default defineConfig({
  base: './',
  build: { target: 'es2020', sourcemap: false },
});
