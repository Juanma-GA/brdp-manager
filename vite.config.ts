import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forwards to the FastAPI backend (backend/app/main.py), which must be
      // running separately (`uvicorn app.main:app`) -- Vite only proxies the
      // request, it does not start that process.
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
