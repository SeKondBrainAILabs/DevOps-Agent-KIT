#!/usr/bin/env node

/**
 * File Coordination System for Multi-Agent Development
 * 
 * This module provides conflict detection and reporting for multiple agents
 * editing files in the same repository. It implements an advisory lock system
 * where agents declare their intent to edit files, and conflicts are reported
 * to users for resolution.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class FileCoordinator {
  constructor(sessionId, workingDir = process.cwd(), repoRoot = null) {
    this.sessionId = sessionId;
    this.workingDir = workingDir;
    
    // Find repository root (shared across all worktrees)
    this.repoRoot = repoRoot || this.findRepoRoot(workingDir);
    
    // Use shared coordination directory in local_deploy
    // This ensures all agents can see each other's file locks
    this.coordDir = path.join(this.repoRoot, 'local_deploy', '.file-coordination');
    this.activeEditsDir = path.join(this.coordDir, 'active-edits');
    this.completedEditsDir = path.join(this.coordDir, 'completed-edits');
    this.conflictsDir = path.join(this.coordDir, 'conflicts');
    
    // Ensure directories exist
    this.ensureDirectories();
  }
  
  /**
   * Find the repository root (works from worktrees too)
   */
  findRepoRoot(startDir) {
    try {
      const { execSync } = require('child_process');
      // This works even from worktrees - returns main repo root
      const superproject = execSync('git rev-parse --show-superproject-working-tree', { 
        cwd: startDir, 
        encoding: 'utf8' 
      }).trim();
      
      if (superproject) {
        return superproject;
      }
      
      return execSync('git rev-parse --show-toplevel', { 
        cwd: startDir, 
        encoding: 'utf8' 
      }).trim();
    } catch (err) {
      // Fallback to working directory if git fails
      return startDir;
    }
  }

  ensureDirectories() {
    [this.coordDir, this.activeEditsDir, this.completedEditsDir, this.conflictsDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Get all active declarations from other agents
   */
  getActiveDeclarations() {
    const declarations = {};
    
    if (!fs.existsSync(this.activeEditsDir)) {
      return declarations;
    }

    const files = fs.readdirSync(this.activeEditsDir);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const content = fs.readFileSync(path.join(this.activeEditsDir, file), 'utf8');
          const declaration = JSON.parse(content);
          
          // Check if declaration is still valid (not expired)
          const declaredAt = new Date(declaration.declaredAt);
          const estimatedDuration = declaration.estimatedDuration || 300; // 5 minutes default
          const expiresAt = new Date(declaredAt.getTime() + estimatedDuration * 1000);
          
          if (new Date() < expiresAt) {
            declarations[file] = declaration;
          } else {
            // Move expired declaration to completed
            this.moveToCompleted(file);
          }
        } catch (err) {
          console.error(`Error reading declaration ${file}:`, err.message);
        }
      }
    }
    
    return declarations;
  }

  /**
   * Check if specific files are currently being edited by other agents
   */
  checkFilesForConflicts(filesToCheck) {
    const conflicts = [];
    const declarations = this.getActiveDeclarations();
    
    for (const [declFile, declaration] of Object.entries(declarations)) {
      // Skip our own declarations
      if (declaration.session === this.sessionId) {
        continue;
      }
      
      // Check for file overlaps
      const declaredFiles = declaration.files || [];
      for (const file of filesToCheck) {
        if (declaredFiles.includes(file)) {
          conflicts.push({
            file,
            conflictsWith: declaration.agent,
            session: declaration.session,
            reason: declaration.reason || 'No reason provided',
            declaredAt: declaration.declaredAt
          });
        }
      }
    }
    
    return conflicts;
  }

  /**
   * Detect conflicts between actual changes and declared edits
   */
  async detectUndeclaredEdits() {
    try {
      // Get list of modified files from git
      const modifiedFiles = execSync('git diff --name-only', {
        cwd: this.workingDir,
        encoding: 'utf8'
      }).trim().split('\n').filter(f => f);
      
      const stagedFiles = execSync('git diff --cached --name-only', {
        cwd: this.workingDir,
        encoding: 'utf8'
      }).trim().split('\n').filter(f => f);
      
      const allChangedFiles = [...new Set([...modifiedFiles, ...stagedFiles])];
      
      if (allChangedFiles.length === 0) {
        return { hasConflicts: false };
      }
      
      // Check if these files are declared by someone
      const conflicts = this.checkFilesForConflicts(allChangedFiles);
      
      // Check if we have our own declaration
      const ourDeclarationFile = this.findOurDeclaration();
      let ourDeclaredFiles = [];
      
      if (ourDeclarationFile) {
        try {
          const content = fs.readFileSync(ourDeclarationFile, 'utf8');
          const declaration = JSON.parse(content);
          ourDeclaredFiles = declaration.files || [];
        } catch (err) {
          console.error('Error reading our declaration:', err.message);
        }
      }
      
      // Find undeclared edits (files we changed but didn't declare)
      const undeclaredEdits = allChangedFiles.filter(
        file => !ourDeclaredFiles.includes(file)
      );
      
      return {
        hasConflicts: conflicts.length > 0 || undeclaredEdits.length > 0,
        conflicts,
        undeclaredEdits,
        allChangedFiles
      };
      
    } catch (err) {
      console.error('Error detecting undeclared edits:', err.message);
      return { hasConflicts: false, error: err.message };
    }
  }

  /**
   * Find our current declaration file
   * Matches files like: warp-8sf9-c9ea.json or claude-8sf9-c9ea.json
   * where sessionId is 8sf9-c9ea
   */
  findOurDeclaration() {
    if (!fs.existsSync(this.activeEditsDir)) {
      return null;
    }
    
    const files = fs.readdirSync(this.activeEditsDir);
    
    // First try: Look for session ID in filename (with or without agent prefix)
    // Handles: warp-8sf9-c9ea.json, claude-8sf9-c9ea.json, 8sf9-c9ea.json
    for (const file of files) {
      if (file.endsWith('.json')) {
        // Extract potential session ID from filename
        // Remove .json extension
        const baseName = file.replace('.json', '');
        
        // Check if filename ends with our session ID (handles agent-sessionId format)
        if (baseName.endsWith(this.sessionId) || baseName === this.sessionId) {
          return path.join(this.activeEditsDir, file);
        }
        
        // Also check if session ID appears anywhere in the filename
        if (file.includes(this.sessionId)) {
          return path.join(this.activeEditsDir, file);
        }
      }
    }
    
    // Second try: Look for session ID in file content
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const content = fs.readFileSync(path.join(this.activeEditsDir, file), 'utf8');
          const declaration = JSON.parse(content);
          if (declaration.session === this.sessionId) {
            return path.join(this.activeEditsDir, file);
          }
        } catch (err) {
          // Skip invalid files
        }
      }
    }
    
    return null;
  }

  /**
   * Create a conflict report for the user
   */
  createConflictReport(conflictData) {
    const timestamp = new Date().toISOString();
    const reportFile = path.join(this.conflictsDir, `conflict-${this.sessionId}-${Date.now()}.md`);
    
    let report = `# ⚠️ FILE COORDINATION CONFLICT DETECTED\n\n`;
    report += `**Time:** ${timestamp}\n`;
    report += `**Session:** ${this.sessionId}\n\n`;
    
    if (conflictData.conflicts && conflictData.conflicts.length > 0) {
      report += `## 🔒 Files Being Edited by Other Agents\n\n`;
      report += `The following files are currently being edited by other agents:\n\n`;
      
      for (const conflict of conflictData.conflicts) {
        report += `### ${conflict.file}\n`;
        report += `- **Blocked by:** ${conflict.conflictsWith} (session: ${conflict.session})\n`;
        report += `- **Reason:** ${conflict.reason}\n`;
        report += `- **Since:** ${conflict.declaredAt}\n\n`;
      }
      
      report += `### ❌ ACTION REQUIRED\n\n`;
      report += `You have attempted to edit files that are currently locked by other agents.\n\n`;
      report += `**Options:**\n`;
      report += `1. **Wait** for the other agent to complete their edits\n`;
      report += `2. **Coordinate** with ${conflictData.conflicts[0].conflictsWith} to resolve the conflict\n`;
      report += `3. **Choose different files** to edit\n`;
      report += `4. **Force override** (not recommended - will cause merge conflicts)\n\n`;
    }
    
    if (conflictData.undeclaredEdits && conflictData.undeclaredEdits.length > 0) {
      report += `## 📝 Undeclared File Edits\n\n`;
      report += `The following files were edited without declaration:\n\n`;
      
      for (const file of conflictData.undeclaredEdits) {
        report += `- ${file}\n`;
      }
      
      report += `\n### ⚠️ ADVISORY WARNING\n\n`;
      report += `These files were modified without following the coordination protocol.\n\n`;
      report += `**To fix this:**\n`;
      report += `1. Run: \`./scripts/coordination/declare-file-edits.sh ${this.sessionId.split('-')[0]} ${this.sessionId} ${conflictData.undeclaredEdits.join(' ')}\`\n`;
      report += `2. Or revert these changes if they were unintentional\n\n`;
    }
    
    report += `## 📋 How to Resolve\n\n`;
    report += `1. **Check current declarations:**\n`;
    report += `   \`\`\`bash\n`;
    report += `   ls -la .file-coordination/active-edits/\n`;
    report += `   \`\`\`\n\n`;
    report += `2. **Declare your intended edits:**\n`;
    report += `   \`\`\`bash\n`;
    report += `   ./scripts/coordination/declare-file-edits.sh <agent-name> ${this.sessionId} <files...>\n`;
    report += `   \`\`\`\n\n`;
    report += `3. **Release files when done:**\n`;
    report += `   \`\`\`bash\n`;
    report += `   ./scripts/coordination/release-file-edits.sh <agent-name> ${this.sessionId}\n`;
    report += `   \`\`\`\n\n`;
    
    report += `---\n`;
    report += `*This report was generated automatically by the File Coordination System*\n`;
    
    // Write report
    fs.writeFileSync(reportFile, report);
    
    // Also write a simplified alert to stdout
    console.log('\n' + '='.repeat(60));
    console.log('⚠️  FILE COORDINATION CONFLICT DETECTED');
    console.log('='.repeat(60));
    
    if (conflictData.conflicts && conflictData.conflicts.length > 0) {
      console.log('\n❌ BLOCKED FILES:');
      for (const conflict of conflictData.conflicts) {
        console.log(`   ${conflict.file} (locked by ${conflict.conflictsWith})`);
      }
    }
    
    if (conflictData.undeclaredEdits && conflictData.undeclaredEdits.length > 0) {
      console.log('\n📝 UNDECLARED EDITS:');
      for (const file of conflictData.undeclaredEdits) {
        console.log(`   ${file}`);
      }
    }
    
    console.log(`\n📄 Full report: ${reportFile}`);
    console.log('='.repeat(60) + '\n');
    
    return reportFile;
  }

  /**
   * Move a declaration to completed
   */
  moveToCompleted(filename) {
    const sourcePath = path.join(this.activeEditsDir, filename);
    const destPath = path.join(this.completedEditsDir, filename);
    
    try {
      if (fs.existsSync(sourcePath)) {
        fs.renameSync(sourcePath, destPath);
      }
    } catch (err) {
      console.error(`Error moving ${filename} to completed:`, err.message);
    }
  }

  /**
   * Clean up old/stale declarations
   */
  cleanupStaleDeclarations(maxAgeMinutes = 60) {
    const now = new Date();
    const maxAge = maxAgeMinutes * 60 * 1000;
    
    if (!fs.existsSync(this.activeEditsDir)) {
      return;
    }
    
    const files = fs.readdirSync(this.activeEditsDir);
    let cleaned = 0;
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(this.activeEditsDir, file);
        const stats = fs.statSync(filePath);
        const age = now - stats.mtime;
        
        if (age > maxAge) {
          this.moveToCompleted(file);
          cleaned++;
        }
      }
    }
    
    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} stale declaration(s)`);
    }
  }
}

// Export for use in other modules
module.exports = FileCoordinator;

// If run directly, perform a conflict check
if (require.main === module) {
  const sessionId = process.env.DEVOPS_SESSION_ID || 'manual-check';
  const coordinator = new FileCoordinator(sessionId);
  
  console.log('Checking for file coordination conflicts...');
  
  coordinator.detectUndeclaredEdits().then(result => {
    if (result.hasConflicts) {
      coordinator.createConflictReport(result);
      process.exit(1);
    } else {
      console.log('✅ No conflicts detected');
      process.exit(0);
    }
  });
}