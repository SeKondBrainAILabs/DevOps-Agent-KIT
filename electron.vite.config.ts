/**
 * Electron-Vite Configuration
 * SeKondBrain Kanvas
 *
 * Features:
 * - Dynamic port allocation: Automatically finds a free port on startup
 * - Falls back to ports 5173-5183 range if preferred port is busy
 */

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import detectPort from 'detect-port';
import { cpSync, existsSync, mkdirSync } from 'fs';

// Plugin to copy config files to dist during build
function copyConfigPlugin() {
  return {
    name: 'copy-config',
    closeBundle() {
      const srcConfig = resolve(__dirname, 'electron/config');
      const destConfig = resolve(__dirname, 'dist/config');
      if (existsSync(srcConfig)) {
        mkdirSync(destConfig, { recursive: true });
        cpSync(srcConfig, destConfig, { recursive: true });
        console.log('[Kanvas] Copied config to dist/config');
      }
    },
  };
}

// Preferred port - will try this first, then find next available
const PREFERRED_PORT = 5173;

export default defineConfig(async () => {
  // Find an available port starting from PREFERRED_PORT
  const availablePort = await detectPort(PREFERRED_PORT);

  if (availablePort !== PREFERRED_PORT) {
    console.log(`[Kanvas] Port ${PREFERRED_PORT} is busy, using port ${availablePort}`);
  } else {
    console.log(`[Kanvas] Using port ${availablePort}`);
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin(), copyConfigPlugin()],
      build: {
        outDir: 'dist/electron',
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'electron/index.ts'),
            'monitor-worker': resolve(__dirname, 'electron/worker/monitor-worker.ts'),
          },
          output: {
            entryFileNames: '[name].js',
          },
        },
      },
      resolve: {
        alias: {
          '@shared': resolve(__dirname, 'shared'),
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: 'dist/preload',
        lib: {
          entry: 'electron/preload.ts',
        },
      },
      resolve: {
        alias: {
          '@shared': resolve(__dirname, 'shared'),
        },
      },
    },
    renderer: {
      plugins: [react()],
      root: '.',
      build: {
        outDir: 'dist/renderer',
        rollupOptions: {
          input: 'index.html',
        },
      },
      resolve: {
        alias: {
          '@': resolve(__dirname, 'renderer'),
          '@shared': resolve(__dirname, 'shared'),
        },
      },
      server: {
        port: availablePort,
        strictPort: false, // Allow fallback to next available port
      },
    },
  };
});
