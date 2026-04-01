/**
 * InstructionsModal Component Tests
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstructionsModal } from '../../../renderer/components/features/InstructionsModal';
import type { AgentInstance } from '../../../shared/types';

describe('InstructionsModal', () => {
  const mockOnClose = jest.fn();

  const defaultInstance: AgentInstance = {
    id: 'inst_123',
    config: {
      repoPath: '/Users/test/my-project',
      agentType: 'claude',
      taskDescription: 'Implement user authentication',
      branchName: 'feature/user-auth',
      baseBranch: 'main',
      useWorktree: false,
      autoCommit: true,
      commitInterval: 30000,
      rebaseFrequency: 'never',
      systemPrompt: '',
      contextPreservation: '',
    },
    status: 'waiting',
    createdAt: new Date().toISOString(),
    instructions: `## Setup Instructions

1. Navigate to the repository:
\`\`\`bash
cd /Users/test/my-project
\`\`\`

2. Set environment variables:
\`\`\`bash
export KANVAS_SESSION_ID=sess_123
export KANVAS_REPO_PATH=/Users/test/my-project
\`\`\`

3. Checkout the branch:
\`\`\`bash
git checkout feature/user-auth
\`\`\`

### Task

Implement user authentication

---

**Ready to start!**`,
    sessionId: 'sess_123456789',
    prompt: 'This is the prompt to copy for Claude Code',
  };

  // Mock clipboard at module level
  const mockClipboardWriteText = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockClipboardWriteText.mockClear();

    // Mock clipboard API
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: mockClipboardWriteText,
      },
      writable: true,
      configurable: true,
    });
  });

  describe('Rendering', () => {
    it('should render the modal', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      expect(screen.getByText(/agent instance created/i)).toBeInTheDocument();
    });

    it('should display success header', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      expect(screen.getByText(/agent instance created/i)).toBeInTheDocument();
      expect(screen.getByText(/copy the prompt below/i)).toBeInTheDocument();
    });

    it('should display waiting status', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      expect(screen.getByText(/waiting for agent to connect/i)).toBeInTheDocument();
    });

    it('should display truncated session ID', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      // Session ID is truncated to first 12 chars
      expect(screen.getByText(/sess_123456/)).toBeInTheDocument();
    });
  });

  describe('View Mode Toggle', () => {
    it('should have Prompt and Full Setup toggle buttons', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      // Look for exact "Prompt" text button (not "Copy Prompt")
      expect(screen.getByRole('button', { name: /^prompt$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /full setup/i })).toBeInTheDocument();
    });

    it('should default to Prompt view', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      const promptButton = screen.getByRole('button', { name: /^prompt$/i });
      expect(promptButton).toHaveClass('bg-kanvas-blue');
    });

    it('should switch to Full Setup view when clicked', async () => {
      const user = userEvent.setup();
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      await user.click(screen.getByRole('button', { name: /full setup/i }));

      const fullSetupButton = screen.getByRole('button', { name: /full setup/i });
      expect(fullSetupButton).toHaveClass('bg-kanvas-blue');
    });
  });

  describe('Copy Functionality', () => {
    it('should have Copy Prompt button', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      // There are multiple Copy Prompt buttons (floating + footer)
      const buttons = screen.getAllByRole('button', { name: /copy prompt/i });
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should have Copy Full Instructions button', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      expect(screen.getByRole('button', { name: /copy full instructions/i })).toBeInTheDocument();
    });

    it('should have clickable copy prompt buttons', async () => {
      const user = userEvent.setup();
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      // Use getAllByRole since there are multiple copy prompt buttons
      const buttons = screen.getAllByRole('button', { name: /copy prompt/i });
      expect(buttons.length).toBeGreaterThan(0);

      // Clicking should not throw
      await user.click(buttons[0]);
    });

    it('should have clickable copy full instructions button', async () => {
      const user = userEvent.setup();
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      const copyFullButton = screen.getByRole('button', { name: /copy full instructions/i });
      expect(copyFullButton).toBeInTheDocument();

      // Clicking should not throw
      await user.click(copyFullButton);
    });
  });

  describe('Terminal Button', () => {
    it('should have Terminal button', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      expect(screen.getByRole('button', { name: /terminal/i })).toBeInTheDocument();
    });

    it('should call openTerminal when Terminal is clicked', async () => {
      const mockOpenTerminal = jest.fn().mockResolvedValue(undefined);
      (window as any).api = {
        ...(window as any).api,
        shell: {
          ...(window as any).api?.shell,
          openTerminal: mockOpenTerminal,
        },
      };
      const user = userEvent.setup();
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      await user.click(screen.getByRole('button', { name: /terminal/i }));

      expect(mockOpenTerminal).toHaveBeenCalledWith(defaultInstance.config.repoPath);
    });
  });

  describe('Done Button', () => {
    it('should have Done button', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    });

    it('should close modal when Done is clicked', async () => {
      const user = userEvent.setup();
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      await user.click(screen.getByRole('button', { name: /done/i }));

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe('Modal Backdrop', () => {
    it('should close when backdrop is clicked', async () => {
      const user = userEvent.setup();
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      const backdrop = document.querySelector('.modal-backdrop');
      if (backdrop) {
        await user.click(backdrop);
        expect(mockOnClose).toHaveBeenCalled();
      }
    });
  });

  describe('Empty Instructions', () => {
    it('should handle empty instructions gracefully', () => {
      const instanceWithoutInstructions: AgentInstance = {
        ...defaultInstance,
        instructions: '',
      };

      render(<InstructionsModal instance={instanceWithoutInstructions} onClose={mockOnClose} />);

      // Should still render without crashing
      expect(screen.getByText(/agent instance created/i)).toBeInTheDocument();
    });

    it('should handle undefined instructions', () => {
      const instanceWithoutInstructions: AgentInstance = {
        ...defaultInstance,
        instructions: undefined,
      };

      render(<InstructionsModal instance={instanceWithoutInstructions} onClose={mockOnClose} />);

      expect(screen.getByText(/agent instance created/i)).toBeInTheDocument();
    });
  });

  describe('Status Indicator', () => {
    it('should show yellow pulsing indicator for waiting status', () => {
      render(<InstructionsModal instance={defaultInstance} onClose={mockOnClose} />);

      const statusIndicator = document.querySelector('.animate-pulse');
      expect(statusIndicator).toBeInTheDocument();
      expect(statusIndicator).toHaveClass('bg-yellow-500');
    });
  });
});
