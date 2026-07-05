import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  base: '/3d_modeler/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        modeller: resolve(__dirname, 'modeller.html'),
      },
    },
  },
})