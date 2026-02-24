import { execSync } from 'child_process'
import { defineConfig, loadEnv } from 'vite'
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
    sceneMarkers: false,
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
    sceneMarkers: true,
  }
  return { ...defaults, ...preset }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env files so values are available for `define` replacements.
  // process.env only contains system env vars; .env file values require loadEnv.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }

  return {
    base: env.VITE_BASE_PATH || '/',
    define: {
      __APP_VERSION__: JSON.stringify(env.npm_package_version ?? '0.0.0'),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
      __BUILD_COMMIT__: JSON.stringify(getGitCommitHash()),
      __CORS_PROXY_URL__: JSON.stringify(env.VITE_CORS_PROXY_URL ?? ''),
      __CORS_PROXY_HMAC_KEY__: JSON.stringify(env.VITE_CORS_PROXY_HMAC_KEY ?? ''),
      ...(resolveModulePreset() ? { __MODULE_PRESET__: JSON.stringify(resolveModulePreset()) } : {}),
    },
    server: {
      host: '0.0.0.0',
      allowedHosts: ['gpu1.pre.sbc.dc'],
    },
    plugins: [react()],
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }
})
