/**
 * Electron-Vite Configuration
 * SeKondBrain Kanvas
 *
 * Features:
 * - Dynamic port allocation: Automatically finds a free port on startup
 * - Falls back to ports 5173-5183 range if preferred port is busy
 * - Uses KANVAS_PORT and KANVAS_PORT_RANGE environment variables for configuration
 */

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import detectPort from 'detect-port';
import { cpSync, existsSync, mkdirSync } from 'fs';
import { getPortConfig } from '@shared/portConfig';

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
  const { preferredPort, portRange } = getPortConfig();
  
  // Find an available port within the configured range
  let availablePort = preferredPort;
  let portFound = false;
  
  // First try the preferred port, then try ports in range
  for (let p = preferredPort; p <= portRange.end; p++) {
    if (await detectPort(p) === p) {
      availablePort = p;
      portFound = true;
      break;
    }
  }
  
  // If preferred port and range don't contain a free port, try from range start
  if (!portFound) {
    for (let p = portRange.start; p <= portRange.end; p++) {
      if (await detectPort(p) === p) {
        availablePort = p;
        portFound = true;
        break;
      }
    }
  }
  
  // If no free port found in range, throw an error
  if (!portFound) {
    throw new Error(`No free Kanvas port in ${portRange.start}-${portRange.end}`);
  }
  
  if (availablePort !== preferredPort) {
    console.log(`[Kanvas] Port ${preferredPort} is busy, using port ${availablePort}`);
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
