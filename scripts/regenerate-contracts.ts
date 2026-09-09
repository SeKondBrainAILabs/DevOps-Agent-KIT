/**
 * Script to regenerate contracts for a repository
 * Run with: npx tsx scripts/regenerate-contracts.ts <repoPath>
 */

import { promises as fs } from 'fs';
import path from 'path';

// Simulate the contract generation without needing the full Electron app
// This script will call the AI service directly to regenerate contracts

const REPO_PATH = process.argv[2] || '/Volumes/Simba User Data/Development/Linkedin-New-Summary/local_deploy/claude-session-20260114-conceptwork';

const CONTRACT_TYPES = ['infra', 'features', 'integrations', 'events'];

async function extractInfraData(repoPath: string): Promise<string> {
  const data: string[] = [];

  // Find docker-compose files
  const files = await fs.readdir(repoPath, { recursive: false });
  for (const file of files) {
    if (typeof file === 'string' && (file.includes('docker-compose') && (file.endsWith('.yml') || file.endsWith('.yaml')))) {
      const content = await fs.readFile(path.join(repoPath, file), 'utf-8');
      data.push(`\n--- ${file} ---\n${content}`);
    }
  }

  // Find .env.example
  try {
    const envExample = await fs.readFile(path.join(repoPath, '.env.example'), 'utf-8');
    data.push(`\n--- .env.example ---\n${envExample}`);
  } catch { /* ignore */ }

  return data.join('\n');
}

async function main() {
  console.log(`Regenerating contracts for: ${REPO_PATH}`);

  // Read the docker-compose to show what we found
  const infraData = await extractInfraData(REPO_PATH);
  console.log(`\nExtracted infrastructure data length: ${infraData.length} chars`);

  // Parse services from docker-compose
  const serviceMatches = infraData.match(/^\s{2}[\w-]+:\s*$/gm) || [];
  console.log(`\nFound services: ${serviceMatches.map(s => s.trim().replace(':', '')).join(', ')}`);

  // Parse images
  const imageMatches = infraData.match(/image:\s*[\w\/:.-]+/g) || [];
  console.log(`Found images: ${imageMatches.map(i => i.replace('image:', '').trim()).join(', ')}`);

  // Parse ports
  const portMatches = infraData.match(/"(\d+):(\d+)"/g) || [];
  console.log(`Found ports: ${portMatches.join(', ')}`);

  console.log('\n--- Infrastructure Data Sample (first 5000 chars) ---');
  console.log(infraData.slice(0, 5000));

  console.log('\n\nTo regenerate contracts, run the Kanvas app and use the contract generation UI.');
  console.log('The improved extraction logic will now properly extract data from docker-compose.yml.');
}

main().catch(console.error);
