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

type ModulePreset = Record<string, boolean>;

const MODULE_PRESETS: Record<string, ModulePreset> = {
  full: {},
  production: {
    filmstrip: false,
    qualityCompare: false,
    audioLevels: false,
    segmentExport: false,
  },
  minimal: {
    filmstrip: false,
    qualityCompare: false,
    statsPanel: false,
    audioLevels: false,
    segmentExport: false,
    subtitles: false,
    adaptationToast: false,
    keyboardShortcuts: false,
    sleepWakeRecovery: false,
  },
}

function resolveModulePreset(): ModulePreset | undefined {
  const name = process.env.VITE_MODULE_PRESET ?? 'full'
  const preset = MODULE_PRESETS[name]
  if (!preset) {
    console.warn(`Unknown module preset "${name}", falling back to "full"`)
    return undefined
  }
  // "full" preset means no overrides — return undefined so tree-shaking is not affected
  if (Object.keys(preset).length === 0) return undefined
  // Merge with all-true defaults so the define is a complete config
  const defaults: ModulePreset = {
    filmstrip: true,
    qualityCompare: true,
    statsPanel: true,
    audioLevels: true,
    segmentExport: true,
    subtitles: true,
    adaptationToast: true,
    keyboardShortcuts: true,
    sleepWakeRecovery: true,
  }
  return { ...defaults, ...preset }
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
    __MODULE_PRESET__: JSON.stringify(resolveModulePreset()),
  },
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
