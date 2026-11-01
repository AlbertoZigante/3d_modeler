import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    // /3d_modeler/ on GitHub Pages; set VITE_BASE=/ when served from app.<domain>
    base: env.VITE_BASE || '/',
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          modeller: resolve(__dirname, 'modeller.html'),
          dashboard: resolve(__dirname, 'dashboard.html'),
        },
      },
    },
  }
})
