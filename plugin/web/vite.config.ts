import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // El modelo del diagrama vive fuera de web/ porque el servidor MCP usa el
    // mismo reducer. Sin esto Vite bloquea la lectura.
    fs: { allow: [resolve(__dirname, '..')] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
