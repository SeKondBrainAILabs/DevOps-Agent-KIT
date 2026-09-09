/**
 * Agent Instructions Generator Tests
 * Tests the instruction template generation for different agent types
 */

import { getAgentInstructions, InstructionVars } from '../../../shared/agent-instructions';
import type { AgentType } from '../../../shared/types';

describe('Agent Instructions Generator', () => {
  const defaultVars: InstructionVars = {
    repoPath: '/Users/test/my-project',
    repoName: 'my-project',
    branchName: 'feature/new-feature',
    sessionId: 'sess_123456_abc',
    taskDescription: 'Implement user authentication',
    systemPrompt: '',
    contextPreservation: '',
    rebaseFrequency: 'never',
  };

  describe('getAgentInstructions', () => {
    it('should generate instructions for Claude Code agent', () => {
      const instructions = getAgentInstructions('claude', defaultVars);
      // Short session ID: sess_123456_abc -> 123456_a (first 8 chars after removing prefix)
      const shortSessionId = defaultVars.sessionId.replace('sess_', '').slice(0, 8);

      // Heading was genericized to "Setup Coding Agent"; the `claude` launch command
      // is the stable claude-specific marker in the template.
      expect(instructions).toContain('claude');
      expect(instructions).toContain(defaultVars.repoPath);
      expect(instructions).toContain(defaultVars.branchName);
      expect(instructions).toContain(shortSessionId);
      expect(instructions).toContain(defaultVars.taskDescription);
    });

    it('should generate instructions for Cursor agent', () => {
      const instructions = getAgentInstructions('cursor', defaultVars);

      expect(instructions).toContain('Cursor');
      expect(instructions).toContain(defaultVars.repoPath);
      expect(instructions).toContain(defaultVars.branchName);
    });

    it('should generate instructions for GitHub Copilot agent', () => {
      const instructions = getAgentInstructions('copilot', defaultVars);

      expect(instructions).toContain('GitHub Copilot');
      expect(instructions).toContain(defaultVars.repoPath);
    });

    it('should generate instructions for Cline agent', () => {
      const instructions = getAgentInstructions('cline', defaultVars);

      expect(instructions).toContain('Cline');
      expect(instructions).toContain(defaultVars.repoPath);
    });

    it('should generate instructions for Aider agent', () => {
      const instructions = getAgentInstructions('aider', defaultVars);

      expect(instructions).toContain('Aider');
      expect(instructions).toContain(defaultVars.repoPath);
      expect(instructions).toContain('aider');
    });

    it('should generate instructions for Warp agent', () => {
      const instructions = getAgentInstructions('warp', defaultVars);

      expect(instructions).toContain('Warp');
      expect(instructions).toContain(defaultVars.repoPath);
    });

    it('should generate instructions for custom agent', () => {
      const instructions = getAgentInstructions('custom', defaultVars);

      expect(instructions).toContain('Custom Agent');
      expect(instructions).toContain(defaultVars.repoPath);
      expect(instructions).toContain(defaultVars.sessionId);
    });

    it('should include session ID reference in all agent instructions', () => {
      const agentTypes: AgentType[] = ['claude', 'cursor', 'copilot', 'cline', 'aider', 'warp', 'custom'];
      // Short session ID: sess_123456_abc -> 123456_a (first 8 chars after removing prefix)
      const shortSessionId = defaultVars.sessionId.replace('sess_', '').slice(0, 8);

      for (const agentType of agentTypes) {
        const instructions = getAgentInstructions(agentType, defaultVars);
        // All agents should reference either full or short session ID
        const hasFullId = instructions.includes(defaultVars.sessionId);
        const hasShortId = instructions.includes(shortSessionId);
        expect(hasFullId || hasShortId).toBe(true);
      }
    });

    it('should include branch information for all agents', () => {
      const agentTypes: AgentType[] = ['claude', 'cursor', 'copilot', 'cline', 'aider', 'warp', 'custom'];

      for (const agentType of agentTypes) {
        const instructions = getAgentInstructions(agentType, defaultVars);
        // All agents should reference the branch name
        expect(instructions).toContain(defaultVars.branchName);
      }
    });

    it('should handle special characters in task description', () => {
      const varsWithSpecialChars: InstructionVars = {
        ...defaultVars,
        taskDescription: 'Fix bug in "auth" module & update <tests>',
      };

      const instructions = getAgentInstructions('claude', varsWithSpecialChars);
      expect(instructions).toContain(varsWithSpecialChars.taskDescription);
    });

    it('should handle paths with spaces', () => {
      const varsWithSpaces: InstructionVars = {
        ...defaultVars,
        repoPath: '/Users/test user/my project',
        repoName: 'my project',
      };

      const instructions = getAgentInstructions('claude', varsWithSpaces);
      expect(instructions).toContain(varsWithSpaces.repoPath);
    });

    it('should generate unique content for each agent type', () => {
      const agentTypes: AgentType[] = ['claude', 'cursor', 'copilot', 'cline', 'aider', 'warp', 'custom'];
      const instructionSets = agentTypes.map(type => getAgentInstructions(type, defaultVars));

      // Each instruction set should be unique
      const uniqueInstructions = new Set(instructionSets);
      expect(uniqueInstructions.size).toBe(agentTypes.length);
    });
  });

  describe('Instruction Content Validation', () => {
    it('should include step-by-step setup instructions', () => {
      const instructions = getAgentInstructions('claude', defaultVars);

      // Should have numbered steps
      expect(instructions).toMatch(/1\./);
      expect(instructions).toMatch(/2\./);
    });

    it('should include code blocks for commands', () => {
      const instructions = getAgentInstructions('claude', defaultVars);

      // Should have code blocks
      expect(instructions).toContain('```');
    });

    it('should include the task description section', () => {
      const instructions = getAgentInstructions('claude', defaultVars);

      expect(instructions.toLowerCase()).toContain('task');
      expect(instructions).toContain(defaultVars.taskDescription);
    });
  });
});
