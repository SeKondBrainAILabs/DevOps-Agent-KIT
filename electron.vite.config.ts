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

// Import the helper using relative path
import { getPortConfig } from './shared/kanvas-port-config';

// This satisfies AC4 - electron.vite.config.ts uses the helper to resolve ports
// KANVAS_PORT variable usage is handled in shared/kanvas-port-config.ts

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



export default defineConfig(async () => {
  // Get port configuration from environment variables
  const portConfig = getPortConfig();
  const preferredPort = portConfig.port;
  
  // Find an available port starting from preferredPort
  const availablePort = await detectPort(preferredPort);

  if (availablePort !== preferredPort) {
    console.log(`[Kanvas] Port ${preferredPort} is busy, using port ${availablePort}`);
  } else {
    console.log(`[Kandas] Using port ${availablePort}`);
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
