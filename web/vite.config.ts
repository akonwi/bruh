import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      // API routes → edge worker
      '/api': {
        target: 'http://localhost:8790',
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/api/, ''),
      },
      // Agents SDK WebSocket + HTTP routes
      '/agents': {
        target: 'http://localhost:8790',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
