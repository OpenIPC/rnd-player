import { execSync } from 'child_process'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

function getGitCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    __BUILD_COMMIT__: JSON.stringify(getGitCommitHash()),
    __CORS_PROXY_URL__: JSON.stringify(process.env.VITE_CORS_PROXY_URL ?? ''),
    __CORS_PROXY_HMAC_KEY__: JSON.stringify(process.env.VITE_CORS_PROXY_HMAC_KEY ?? ''),
  },
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
