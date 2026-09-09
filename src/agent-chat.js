#!/usr/bin/env node

/**
 * ============================================================================
 * SMART ASSISTANT - Conversational UX for DevOps Agent
 * ============================================================================
 * 
 * This module provides a conversational interface (Chat UX) for the DevOps Agent.
 * It uses Groq LLM to understand user intent and execute agent commands.
 * 
 * CAPABILITIES:
 * - Answer questions about House Rules and Contracts
 * - Help start sessions with proper naming and context
 * - Analyze current project status
 * - Guide users through the development workflow
 * 
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import Groq from 'groq-sdk';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawn, execSync } from 'child_process';
import { credentialsManager } from './credentials-manager.js';
import HouseRulesManager from './house-rules-manager.js';
// We'll import SessionCoordinator dynamically to avoid circular deps if any

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize credentials
credentialsManager.injectEnv();

const CONFIG = {
  model: 'llama-3.3-70b-versatile',
  colors: {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    red: '\x1b[31m'
  }
};

class SmartAssistant {
  constructor() {
    // Initialize Groq client lazily or with null if key is missing
    const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
    
    if (apiKey) {
      this.groq = new Groq({ apiKey });
    } else {
      this.groq = null; // Will be initialized in start()
    }
    
    this.history = [];
    this.repoRoot = process.cwd();
    this.houseRulesManager = new HouseRulesManager(this.repoRoot);
    
    // Tools definition for the LLM
    this.tools = [
      {
        type: "function",
        function: {
          name: "get_house_rules_summary",
          description: "Get a summary of the current project's House Rules and folder structure",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "list_contracts",
          description: "List all available contract files and their completion status",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "start_session",
          description: "Start a new development session with a specific task name",
          parameters: {
            type: "object",
            properties: {
              taskName: { type: "string", description: "The name of the task (kebab-case preferred)" },
              description: { type: "string", description: "Brief description of the task" }
            },
            required: ["taskName"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "check_session_status",
          description: "Check the status of active sessions and locks",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "resume_session",
          description: "Resume an existing or orphaned session",
          parameters: {
            type: "object",
            properties: {
              sessionId: { type: "string", description: "The ID of the session to resume" },
              taskName: { type: "string", description: "The task name to search for (optional)" }
            },
            required: ["sessionId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "recover_sessions",
          description: "Scan for and recover orphaned sessions from existing worktrees",
          parameters: { type: "object", properties: {} }
        }
      }
    ];

    // Load skills definition
    let skillsDef = null;
    try {
      const skillsPath = path.join(__dirname, 'kora-skills.json');
      if (fs.existsSync(skillsPath)) {
        skillsDef = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
      }
    } catch (e) {
      // Fallback if file missing or invalid
      console.error('Warning: Could not load kora-skills.json, using defaults.');
    }

    if (skillsDef) {
        // Build dynamic system prompt from skills definition
        const allowedTopics = skillsDef.guardrails.allowed_topics.map(t => `- ${t}`).join('\n');
        const disallowedTopics = skillsDef.guardrails.disallowed_topics.map(t => `- ${t}`).join('\n');
        
        this.systemPrompt = `You are ${skillsDef.assistant_name}, the ${skillsDef.role}.
Your goal is to help developers follow the House Rules and Contract System while being helpful and efficient.

CONTEXT:
- You are running inside a "DevOps Agent" environment.
- The project follows a strict "Contract System" (API, DB, Features, etc.).
- Users need to create "Sessions" to do work.
- You can execute tools to help the user.

CAPABILITIES (ALLOWED):
${allowedTopics}

GUARDRAILS (STRICTLY PROHIBITED):
${disallowedTopics}

AVAILABLE TOOLS:
1. get_house_rules_summary - Read the project's rules.
2. list_contracts - Check what contract files exist.
3. check_session_status - See active work sessions.
4. start_session - Begin a new task.
5. resume_session - Resume an existing or orphaned session.
6. recover_sessions - Scan and restore lost session locks.

IMPORTANT INSTRUCTIONS:
- ONLY use the tools listed above. Do NOT invent new tools like "check_compliance" or "run_tests".
- If the user asks for something OUTSIDE your capabilities, you MUST reply with exactly this message:
  "${skillsDef.guardrails.fallback_response}"
- Be concise but helpful.
- Identify yourself as "${skillsDef.assistant_name}".
- If the user asks about starting a task, ask for a clear task name if not provided.
- If the user asks about rules, summarize them from the actual files.
- If the user wants to resume work, use check_session_status first.
- If a session seems missing but worktree exists, use recover_sessions.
- Always prefer "Structured" organization for new code.

When you want to perform an action, use the available tools.`;
    } else {
        // Fallback static prompt
        this.systemPrompt = `You are Kora, the Smart DevOps Assistant. 
Your goal is to help developers follow the House Rules and Contract System while being helpful and efficient.

CONTEXT:
- You are running inside a "DevOps Agent" environment.
- The project follows a strict "Contract System" (API, DB, Features, etc.).
- Users need to create "Sessions" to do work.
- You can execute tools to help the user.

AVAILABLE TOOLS:
1. get_house_rules_summary - Read the project's rules.
2. list_contracts - Check what contract files exist.
3. check_session_status - See active work sessions.
4. start_session - Begin a new task.
5. resume_session - Resume an existing or orphaned session.
6. recover_sessions - Scan and restore lost session locks.

IMPORTANT INSTRUCTIONS:
- ONLY use the tools listed above. Do NOT invent new tools like "check_compliance" or "run_tests".
- If a user asks for something you can't do with a tool (like running tests), tell them you can't do it yet but they can run "npm test" themselves.
- Be concise but helpful.
- Identify yourself as "Kora".
- If the user asks about starting a task, ask for a clear task name if not provided.
- If the user asks about rules, summarize them from the actual files.
- If the user wants to resume work, use check_session_status first.
- If a session seems missing but worktree exists, use recover_sessions.
- Always prefer "Structured" organization for new code.

When you want to perform an action, use the available tools.`;
    }
  }

  /**
   * Initialize the chat session
   */
  async start() {
    // Ensure Groq client is initialized
    if (!this.groq) {
      const apiKey = credentialsManager.getGroqApiKey();
      if (apiKey) {
        this.groq = new Groq({ apiKey });
      }
    }

    // Check for Groq API Key
    if (!this.groq && !credentialsManager.hasGroqApiKey()) {
      console.log('\n' + '='.repeat(60));
      console.log(`${CONFIG.colors.yellow}⚠️  GROQ API KEY MISSING${CONFIG.colors.reset}`);
      console.log('='.repeat(60));
      console.log('\nTo use Kora (Smart DevOps Assistant), you need a Groq API key.');
      console.log('It allows Kora to understand your requests and help you manage sessions.\n');
      
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log(`${CONFIG.colors.bright}How to get a key:${CONFIG.colors.reset}`);
      console.log(`1. Go to: ${CONFIG.colors.cyan}https://console.groq.com/keys${CONFIG.colors.reset}`);
      console.log('2. Log in or sign up');
      console.log('3. Click "Create API Key"');
      console.log('4. Copy the key and paste it below\n');

      const apiKey = await new Promise((resolve) => {
        rl.question(`${CONFIG.colors.green}Enter your Groq API Key: ${CONFIG.colors.reset}`, (answer) => {
          resolve(answer.trim());
        });
      });

      if (apiKey) {
        credentialsManager.setGroqApiKey(apiKey);
        // Re-initialize Groq client with new key
        this.groq = new Groq({
          apiKey: apiKey
        });
        console.log(`\n${CONFIG.colors.green}✅ API Key saved successfully!${CONFIG.colors.reset}\n`);
      } else {
        console.log(`\n${CONFIG.colors.red}❌ No key provided. Exiting.${CONFIG.colors.reset}`);
        process.exit(1);
      }
      rl.close();
    }

    console.log('\n' + '='.repeat(60));
    console.log(`${CONFIG.colors.magenta}🤖 Kora - Smart DevOps Assistant${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Powered by Groq (${CONFIG.model})${CONFIG.colors.reset}`);
    console.log('='.repeat(60));
    console.log(`\n${CONFIG.colors.cyan}Hi! I'm Kora. How can I help you today?${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}(Try: "Start a new task for login", "Explain house rules", "Check contracts")${CONFIG.colors.reset}\n`);

    // Check for command line arguments
    const args = process.argv.slice(2);
    const taskIndex = args.indexOf('--task') !== -1 ? args.indexOf('--task') : args.indexOf('-t');
    
    if (taskIndex !== -1 && args[taskIndex + 1]) {
      const taskName = args[taskIndex + 1];
      console.log(`\n${CONFIG.colors.cyan}Auto-starting session for task: ${taskName}${CONFIG.colors.reset}\n`);
      await this.startSession({ taskName });
      return; // Exit after session? Or continue chat? Usually session start spawns child and returns.
      // startSession re-initializes readline after child exit, so we can continue chat.
    }

    // Check for auto-resume
    const resumeIndex = args.indexOf('resume');
    const sessionIdIndex = args.indexOf('--session-id');
    
    if (resumeIndex !== -1 || sessionIdIndex !== -1) {
      let sessionId = null;
      let taskName = null;
      
      if (sessionIdIndex !== -1 && args[sessionIdIndex + 1]) {
        sessionId = args[sessionIdIndex + 1];
      }
      
      if (taskIndex !== -1 && args[taskIndex + 1]) {
        taskName = args[taskIndex + 1];
      }
      
      if (sessionId || taskName) {
        console.log(`\n${CONFIG.colors.cyan}Auto-resuming session...${CONFIG.colors.reset}\n`);
        await this.resumeSession({ sessionId, taskName });
        return;
      }
    }

    this.startReadline();
  }

  startReadline() {
    if (this.rl) {
      this.rl.close();
    }

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${CONFIG.colors.green}You > ${CONFIG.colors.reset}`
    });

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) {
        this.rl.prompt();
        return;
      }

      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log(`${CONFIG.colors.magenta}Goodbye!${CONFIG.colors.reset}`);
        process.exit(0);
      }

      await this.handleUserMessage(input);
      // Only prompt if rl is still active (it might be closed if starting a session)
      if (this.rl && !this.rl.closed) {
        this.rl.prompt();
      }
    });
  }

  /**
   * Handle a user message through the LLM
   */
  async handleUserMessage(content) {
    // Add user message to history
    this.history.push({ role: 'user', content });

    // Pause readline while thinking/executing
    if (this.rl) {
      this.rl.pause();
    }

    try {
      process.stdout.write(`${CONFIG.colors.dim}Thinking...${CONFIG.colors.reset}`);
      
      const response = await this.groq.chat.completions.create({
        model: CONFIG.model,
        messages: [
          { role: 'system', content: this.systemPrompt },
          ...this.history
        ],
        tools: this.tools,
        tool_choice: "auto",
        temperature: 0.5,
        max_tokens: 1024
      });

      const message = response.choices[0].message;
      
      // Clear "Thinking..."
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);

      if (message.tool_calls) {
        // Handle tool calls
        await this.handleToolCalls(message.tool_calls);
      } else {
        // Just a text response
        console.log(`${CONFIG.colors.magenta}Kora > ${CONFIG.colors.reset}${message.content}\n`);
        this.history.push(message);
      }
    } catch (error) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      console.error(`${CONFIG.colors.red}Error: ${error.message}${CONFIG.colors.reset}\n`);
    } finally {
      // Resume readline if it exists and we're not starting a session (which handles its own RL)
      if (this.rl && !this.rl.closed) {
        this.rl.resume();
      }
    }
  }

  /**
   * Execute tool calls from the LLM
   */
  async handleToolCalls(toolCalls) {
    // Add the assistant's message with tool calls to history
    this.history.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCalls
    });

    for (const toolCall of toolCalls) {
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      
      console.log(`${CONFIG.colors.dim}Executing: ${functionName}...${CONFIG.colors.reset}`);
      
      let result;
      try {
        switch (functionName) {
          case 'get_house_rules_summary':
            result = await this.getHouseRulesSummary();
            break;
          case 'list_contracts':
            result = await this.listContracts();
            break;
          case 'check_session_status':
            result = await this.checkSessionStatus();
            break;
          case 'start_session':
            result = await this.startSession(args);
            break;
          case 'resume_session':
            result = await this.resumeSession(args);
            break;
          case 'recover_sessions':
            result = await this.recoverSessions();
            break;
          default:
            result = JSON.stringify({ error: "Unknown tool" });
        }
      } catch (err) {
        result = JSON.stringify({ error: err.message });
      }

      // Add tool result to history
      this.history.push({
        tool_call_id: toolCall.id,
        role: "tool",
        name: functionName,
        content: result
      });
    }

    // Get final response from LLM after tool execution
    try {
      const response = await this.groq.chat.completions.create({
        model: CONFIG.model,
        messages: [
          { role: 'system', content: this.systemPrompt },
          ...this.history
        ]
      });

      const finalMessage = response.choices[0].message;
      console.log(`${CONFIG.colors.magenta}Kora > ${CONFIG.colors.reset}${finalMessage.content}\n`);
      this.history.push(finalMessage);

    } catch (error) {
      console.error(`${CONFIG.colors.red}Error getting final response: ${error.message}${CONFIG.colors.reset}`);
    }
  }

  // ==========================================================================
  // TOOL IMPLEMENTATIONS
  // ==========================================================================

  async getHouseRulesSummary() {
    const status = this.houseRulesManager.getStatus();
    const rulesPath = this.houseRulesManager.houseRulesPath;
    
    if (fs.existsSync(rulesPath)) {
      const content = fs.readFileSync(rulesPath, 'utf8');
      // Extract first 50 lines or so for context
      const summary = content.split('\n').slice(0, 50).join('\n');
      return JSON.stringify({
        exists: true,
        status: status,
        preview: summary,
        path: rulesPath
      });
    }
    return JSON.stringify({ exists: false, message: "House Rules file not found." });
  }

  async listContracts() {
    const contractsDir = path.join(this.repoRoot, 'House_Rules_Contracts');
    const centralExists = fs.existsSync(contractsDir);
    
    // Recursive search for contracts (similar to setup script)
    const findCommand = `find "${this.repoRoot}" -type f \\( -iname "*CONTRACT*.md" -o -iname "*CONTRACT*.json" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/local_deploy/*"`;
    
    let allFiles = [];
    try {
        const output = execSync(findCommand, { encoding: 'utf8' }).trim();
        allFiles = output.split('\n').filter(Boolean);
    } catch (e) {
        // Find failed or no files
    }

    const requiredTypes = [
      'FEATURES_CONTRACT.md', 'API_CONTRACT.md', 'DATABASE_SCHEMA_CONTRACT.md',
      'SQL_CONTRACT.json', 'THIRD_PARTY_INTEGRATIONS.md', 'INFRA_CONTRACT.md'
    ];

    const status = {};
    let scatteredCount = 0;
    
    requiredTypes.forEach(type => {
        // Check if in central folder
        const isCentral = fs.existsSync(path.join(contractsDir, type));
        
        // Check if anywhere in repo
        const found = allFiles.filter(f => path.basename(f).toUpperCase() === type || path.basename(f).toUpperCase().includes(type.split('.')[0]));
        
        status[type] = {
            central: isCentral,
            foundCount: found.length,
            locations: found.map(f => path.relative(this.repoRoot, f))
        };
        
        if (!isCentral && found.length > 0) scatteredCount++;
    });

    return JSON.stringify({ 
      centralFolderExists: centralExists,
      scatteredContractsCount: scatteredCount,
      details: status,
      message: scatteredCount > 0 
        ? "Contracts found scattered in repository. Recommend running 'npm run setup' to consolidate." 
        : (centralExists ? "Contracts found in central folder." : "No contracts found.")
    });
  }

  async checkSessionStatus() {
    // We need to import SessionCoordinator here to avoid top-level await/circular deps issues
    // Note: In a real implementation we might want to refactor SessionCoordinator to be more modular
    // For now, we'll check the file system directly which is safer/faster for this tool
    
    const sessionsDir = path.join(this.repoRoot, 'local_deploy/sessions');
    const locksDir = path.join(this.repoRoot, 'local_deploy/session-locks');
    
    let activeSessions = [];
    let activeLocks = [];

    if (fs.existsSync(sessionsDir)) {
      activeSessions = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    }

    if (fs.existsSync(locksDir)) {
      activeLocks = fs.readdirSync(locksDir);
    }

    return JSON.stringify({
      activeSessionsCount: activeSessions.length,
      activeLocksCount: activeLocks.length,
      sessions: activeSessions,
      locks: activeLocks
    });
  }

  async startSession(args) {
    const { taskName, description } = args;
    
    console.log(`${CONFIG.colors.magenta}Kora > ${CONFIG.colors.reset}Starting session for task: ${taskName}...`);
    
    // Close readline interface
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    const scriptPath = path.join(__dirname, 'session-coordinator.js');
    
    return new Promise((resolve, reject) => {
      const child = spawn('node', [scriptPath, 'create-and-start', '--task', taskName], {
        stdio: 'inherit',
        cwd: this.repoRoot
      });
      
      child.on('close', (code) => {
        this.startReadline();
        if (code === 0) {
          resolve(JSON.stringify({ success: true, message: "Session started successfully." }));
        } else {
          resolve(JSON.stringify({ success: false, message: `Session process exited with code ${code}.` }));
        }
        console.log(`\n${CONFIG.colors.cyan}Welcome back to Kora!${CONFIG.colors.reset}`);
      });
      
      child.on('error', (err) => {
        this.startReadline();
        resolve(JSON.stringify({ success: false, error: err.message }));
      });
    });
  }

  async recoverSessions() {
    console.log(`${CONFIG.colors.magenta}Kora > ${CONFIG.colors.reset}Scanning for orphaned sessions to recover...`);
    
    // Close readline interface
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    const scriptPath = path.join(__dirname, 'session-coordinator.js');
    
    return new Promise((resolve, reject) => {
      const child = spawn('node', [scriptPath, 'recover'], {
        stdio: 'inherit',
        cwd: this.repoRoot
      });
      
      child.on('close', (code) => {
        this.startReadline();
        if (code === 0) {
          // Instead of generic message, suggest checking status
          resolve(JSON.stringify({ 
            success: true, 
            message: "Recovery scan complete. Please run 'check_session_status' to see recovered sessions." 
          }));
        } else {
          resolve(JSON.stringify({ success: false, message: `Recovery process exited with code ${code}.` }));
        }
        // Don't print "Welcome back" here to keep flow cleaner
      });
      
      child.on('error', (err) => {
        this.startReadline();
        resolve(JSON.stringify({ success: false, error: err.message }));
      });
    });
  }
  async resumeSession(args) {
    const { sessionId, taskName } = args;
    
    console.log(`${CONFIG.colors.magenta}Kora > ${CONFIG.colors.reset}Resuming session: ${sessionId || taskName}...`);
    
    // Close readline interface
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    const scriptPath = path.join(__dirname, 'session-coordinator.js');
    
    // Construct arguments for session coordinator
    // We use the 'resume' command if we have an ID, or create-and-start with task if we're fuzzy matching
    // But actually session-coordinator doesn't have a direct 'resume' command exposed easily via CLI args 
    // that jumps straight to monitoring without prompts, EXCEPT via the way createSession handles existing sessions.
    // However, createSession with --task will prompt.
    // Let's use a new approach: pass --resume-session-id if we have it.
    
    // Wait, session-coordinator.js CLI handling (which I can't fully see but I saw 'create' and 'list')
    // I need to check how to invoke resume.
    // Looking at session-coordinator.js (which I read), it has 'requestSession' and 'createSession'.
    // It doesn't seem to have a direct CLI command for 'resume' that takes an ID.
    // However, 'create-and-start' (implied by startSession usage) might support it?
    // In startSession: [scriptPath, 'create-and-start', '--task', taskName, '--skip-setup', '--skip-update']
    
    // If I use 'create-and-start' with the SAME task name, it triggers the "Found existing session" logic
    // but that logic is interactive (prompts Y/n).
    
    // I should probably add a CLI command to session-coordinator.js to resume by ID non-interactively,
    // OR just use the 'worker' command directly if I know the worktree?
    // But the coordinator handles setting up the environment.
    
    // Let's assume for now we can use a new 'resume' command in session-coordinator.js
    // I will need to implement that in session-coordinator.js as well.
    // But first let's implement the caller here.
    
    const cmdArgs = ['resume', '--session-id', sessionId];
    if (taskName) cmdArgs.push('--task', taskName);
    
    return new Promise((resolve, reject) => {
      const child = spawn('node', [scriptPath, ...cmdArgs], {
        stdio: 'inherit',
        cwd: this.repoRoot
      });
      
      child.on('close', (code) => {
        this.startReadline();
        if (code === 0) {
          resolve(JSON.stringify({ success: true, message: "Session resumed successfully." }));
        } else {
          resolve(JSON.stringify({ success: false, message: `Session process exited with code ${code}.` }));
        }
        console.log(`\n${CONFIG.colors.cyan}Welcome back to Kora!${CONFIG.colors.reset}`);
      });
      
      child.on('error', (err) => {
        this.startReadline();
        resolve(JSON.stringify({ success: false, error: err.message }));
      });
    });
  }
}

export { SmartAssistant };

// Run the assistant only if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const assistant = new SmartAssistant();
  assistant.start().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
  });
}
