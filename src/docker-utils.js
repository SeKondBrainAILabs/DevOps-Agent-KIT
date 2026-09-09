/**
 * ============================================================================
 * DOCKER UTILITIES FOR DEVOPS AGENT
 * ============================================================================
 * 
 * PURPOSE:
 * Provides Docker container management functionality for automatic restarts
 * after code pushes. Integrates with the DevOps agent session workflow.
 * 
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import { execa } from 'execa';

/**
 * Check if Docker is installed and running
 */
export async function isDockerAvailable() {
  try {
    await execa('docker', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if docker-compose is available
 */
export async function isDockerComposeAvailable() {
  try {
    // Try docker compose (v2)
    await execa('docker', ['compose', 'version'], { stdio: 'pipe' });
    return 'docker compose';
  } catch {
    try {
      // Try docker-compose (v1)
      await execa('docker-compose', ['version'], { stdio: 'pipe' });
      return 'docker-compose';
    } catch {
      return false;
    }
  }
}

/**
 * Recursively search for docker-compose files in a directory
 */
function searchDockerFilesRecursive(dir, maxDepth = 3, currentDepth = 0, label = '') {
  const found = [];
  
  if (currentDepth > maxDepth || !fs.existsSync(dir)) {
    return found;
  }
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isFile() && /^docker-compose.*\.ya?ml$/i.test(entry.name)) {
        found.push({
          name: entry.name,
          path: fullPath,
          location: label || path.relative(process.cwd(), dir) || 'current directory'
        });
      } else if (entry.isDirectory() && !entry.name.startsWith('.') && 
                 entry.name !== 'node_modules' && entry.name !== 'local_deploy') {
        // Recursively search subdirectories
        const subResults = searchDockerFilesRecursive(fullPath, maxDepth, currentDepth + 1, label);
        found.push(...subResults);
      }
    }
  } catch (err) {
    // Ignore permission errors
  }
  
  return found;
}

/**
 * Find docker-compose files in the project, parent directory, and Infrastructure folders
 */
export function findDockerComposeFiles(projectPath) {
  const found = [];
  
  const searchLocations = [
    { path: projectPath, label: 'project directory', depth: 2 },
    { path: path.dirname(projectPath), label: 'parent directory', depth: 1 },
    { path: path.join(path.dirname(projectPath), 'Infrastructure'), label: 'parent/Infrastructure', depth: 3 },
    { path: path.join(path.dirname(projectPath), 'infrastructure'), label: 'parent/infrastructure', depth: 3 },
    { path: path.join(projectPath, 'Infrastructure'), label: 'Infrastructure', depth: 3 },
    { path: path.join(projectPath, 'infrastructure'), label: 'infrastructure', depth: 3 }
  ];
  
  for (const location of searchLocations) {
    if (fs.existsSync(location.path)) {
      const results = searchDockerFilesRecursive(location.path, location.depth, 0, location.label);
      found.push(...results);
    }
  }
  
  // Remove duplicates based on absolute path
  const uniqueFound = [];
  const seenPaths = new Set();
  
  for (const file of found) {
    const absPath = path.resolve(file.path);
    if (!seenPaths.has(absPath)) {
      seenPaths.add(absPath);
      uniqueFound.push(file);
    }
  }
  
  return uniqueFound;
}

/**
 * Check if project has Docker configuration
 */
export function hasDockerConfiguration(projectPath) {
  const composeFiles = findDockerComposeFiles(projectPath);
  const dockerfilePath = path.join(projectPath, 'Dockerfile');
  
  return {
    hasCompose: composeFiles.length > 0,
    hasDockerfile: fs.existsSync(dockerfilePath),
    composeFiles: composeFiles
  };
}

/**
 * Restart Docker containers
 */
export async function restartDockerContainers(options = {}) {
  const {
    projectPath = process.cwd(),
    composeFile = null,
    serviceName = null,
    forceRecreate = false,
    rebuild = false,
    detach = true
  } = options;

  console.log('\n🐋 Docker Container Restart');
  console.log('━'.repeat(50));

  try {
    // Check if Docker is available
    const dockerCmd = await isDockerComposeAvailable();
    if (!dockerCmd) {
      throw new Error('Docker Compose is not available');
    }

    // Determine compose file to use
    let composeFilePath = composeFile;
    if (!composeFilePath) {
      const dockerConfig = hasDockerConfiguration(projectPath);
      if (dockerConfig.hasCompose && dockerConfig.composeFiles.length > 0) {
        composeFilePath = dockerConfig.composeFiles[0].path;
      } else {
        throw new Error('No docker-compose file found');
      }
    }

    // Build command arguments
    const isV2 = dockerCmd === 'docker compose';
    const baseCmd = isV2 ? ['docker', 'compose'] : ['docker-compose'];
    const fileArgs = ['-f', composeFilePath];

    // Stop containers
    console.log('📦 Stopping containers...');
    const stopArgs = [...fileArgs, 'stop'];
    if (serviceName) stopArgs.push(serviceName);
    
    const stopResult = await execa(baseCmd[0], [...baseCmd.slice(1), ...stopArgs], {
      cwd: projectPath,
      stdio: 'inherit'
    });

    // Optionally rebuild
    if (rebuild) {
      console.log('🔨 Rebuilding containers...');
      const buildArgs = [...fileArgs, 'build'];
      if (serviceName) buildArgs.push(serviceName);
      
      await execa(baseCmd[0], [...baseCmd.slice(1), ...buildArgs], {
        cwd: projectPath,
        stdio: 'inherit'
      });
    }

    // Start containers
    console.log('🚀 Starting containers...');
    const upArgs = [...fileArgs, 'up'];
    if (forceRecreate) upArgs.push('--force-recreate');
    if (detach) upArgs.push('-d');
    if (serviceName) upArgs.push(serviceName);

    await execa(baseCmd[0], [...baseCmd.slice(1), ...upArgs], {
      cwd: projectPath,
      stdio: 'inherit'
    });

    console.log('✅ Docker containers restarted successfully');
    console.log('━'.repeat(50));
    return { success: true };

  } catch (error) {
    console.error('❌ Failed to restart Docker containers:', error.message);
    console.log('━'.repeat(50));
    return { success: false, error: error.message };
  }
}

/**
 * Get Docker container status
 */
export async function getDockerStatus(projectPath = process.cwd(), composeFile = null) {
  try {
    const dockerCmd = await isDockerComposeAvailable();
    if (!dockerCmd) {
      return { running: false, services: [] };
    }

    let composeFilePath = composeFile;
    if (!composeFilePath) {
      const dockerConfig = hasDockerConfiguration(projectPath);
      if (dockerConfig.hasCompose && dockerConfig.composeFiles.length > 0) {
        composeFilePath = dockerConfig.composeFiles[0].path;
      } else {
        return { running: false, services: [] };
      }
    }

    const isV2 = dockerCmd === 'docker compose';
    const baseCmd = isV2 ? ['docker', 'compose'] : ['docker-compose'];
    const psArgs = ['-f', composeFilePath, 'ps', '--format', 'json'];

    const result = await execa(baseCmd[0], [...baseCmd.slice(1), ...psArgs], {
      cwd: projectPath,
      stdio: 'pipe'
    });

    // Parse the JSON output
    const services = [];
    if (result.stdout) {
      const lines = result.stdout.split('\n').filter(line => line.trim());
      for (const line of lines) {
        try {
          const service = JSON.parse(line);
          services.push({
            name: service.Service || service.Name,
            state: service.State,
            status: service.Status,
            ports: service.Ports
          });
        } catch {
          // Skip unparseable lines
        }
      }
    }

    return {
      running: services.some(s => s.state === 'running'),
      services: services
    };

  } catch (error) {
    return { running: false, services: [], error: error.message };
  }
}

/**
 * Monitor Docker logs
 */
export async function tailDockerLogs(options = {}) {
  const {
    projectPath = process.cwd(),
    composeFile = null,
    serviceName = null,
    lines = 50,
    follow = true
  } = options;

  try {
    const dockerCmd = await isDockerComposeAvailable();
    if (!dockerCmd) {
      throw new Error('Docker Compose is not available');
    }

    let composeFilePath = composeFile;
    if (!composeFilePath) {
      const dockerConfig = hasDockerConfiguration(projectPath);
      if (dockerConfig.hasCompose && dockerConfig.composeFiles.length > 0) {
        composeFilePath = dockerConfig.composeFiles[0].path;
      } else {
        throw new Error('No docker-compose file found');
      }
    }

    const isV2 = dockerCmd === 'docker compose';
    const baseCmd = isV2 ? ['docker', 'compose'] : ['docker-compose'];
    const logsArgs = ['-f', composeFilePath, 'logs'];
    
    if (lines) logsArgs.push('--tail', lines.toString());
    if (follow) logsArgs.push('-f');
    if (serviceName) logsArgs.push(serviceName);

    const proc = execa(baseCmd[0], [...baseCmd.slice(1), ...logsArgs], {
      cwd: projectPath,
      stdio: 'inherit'
    });

    return proc;

  } catch (error) {
    console.error('Failed to tail Docker logs:', error.message);
    return null;
  }
}

export default {
  isDockerAvailable,
  isDockerComposeAvailable,
  findDockerComposeFiles,
  hasDockerConfiguration,
  restartDockerContainers,
  getDockerStatus,
  tailDockerLogs
};