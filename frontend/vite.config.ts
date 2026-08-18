import { defineConfig, loadEnv, ConfigEnv, UserConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }: ConfigEnv): UserConfig => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],

    server: {
      host: '0.0.0.0',
      port: Number(env.FRONTEND_PORT) || 5173,
      strictPort: true,
      allowedHosts: true,

      proxy: {
        '/api': {
          target: env.BACKEND_URL || 'http://backend:8000',
          changeOrigin: true,
          secure: false,
        },

        '/static': {
          target: env.BACKEND_URL || 'http://backend:8000',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})