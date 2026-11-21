import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import { dshCss } from './scripts/dsh-css.mjs'

/** Read the npm version once so the build injects it into src/version.ts. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

/** Build-time define map; `src/version.ts` reads `__DSH_LOOMY_VERSION__`. */
const VERSION_DEFINE = { __DSH_LOOMY_VERSION__: JSON.stringify(PACKAGE_VERSION) }

/**
 * The client bundle runs in the browser, where `process` does not exist.
 * Any dependency that branches on `process.env.NODE_ENV` (React among them)
 * would throw at load time unless the expression is replaced at build time.
 * The host shell's own client preset defines these the same way.
 */
const CLIENT_ENV_DEFINE = {
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
}

// Build both the server bundle (lib/index.mjs) and the client bundle.
// The client bundle is consumed by the DSH web shell via the `dsh.client`
// manifest entry; it must stay framework-light (no node built-ins), and the
// DSH UI packages are left external (provided by the host shell).
export default defineConfig([
  {
    // 宿主侧主 bundle。没有 CLI、没有守护进程：14 天会话由插件进程自己续，
    // 也不需要在 DSH 之外留任何常驻进程。
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    dts: true,
    clean: true,
    outDir: 'lib',
    define: VERSION_DEFINE,
  },
  {
    entry: ['src/client/index.tsx'],
    format: ['cjs'],
    target: 'es2022',
    outDir: 'lib/client',
    define: { ...VERSION_DEFINE, ...CLIENT_ENV_DEFINE },
    deps: {
      neverBundle: [
        '@deepseek-ai/dsh-client-ui-primitives',
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-settings-plugins',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-session',
        '@deepseek-ai/dsh-api-session-controller',
        '@deepseek-ai/dsh-client-locale',
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
      ],
    },
    // 样式走 dsh-css（下面 plugins 里）：那个插件把 *.module.css 编成虚拟模块，
    // 并回写逐类名的 *.module.css.d.ts。
    plugins: [dshCss({ packageName: 'dsh-loomy' })],
  },
])
