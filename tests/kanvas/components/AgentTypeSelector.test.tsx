/**
 * AgentTypeSelector Component Tests
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentTypeSelector } from '../../../renderer/components/features/AgentTypeSelector';
import type { AgentType } from '../../../shared/types';

describe('AgentTypeSelector', () => {
  const mockOnSelect = jest.fn();

  beforeEach(() => {
    mockOnSelect.mockClear();
  });

  it('should render all agent types', () => {
    render(<AgentTypeSelector selectedType={null} onSelect={mockOnSelect} />);

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    expect(screen.getByText('GitHub Copilot')).toBeInTheDocument();
    expect(screen.getByText('Cline')).toBeInTheDocument();
    expect(screen.getByText('Aider')).toBeInTheDocument();
    expect(screen.getByText('Warp')).toBeInTheDocument();
    expect(screen.getByText('Custom Agent')).toBeInTheDocument();
  });

  it('should display the label for agent type selection', () => {
    render(<AgentTypeSelector selectedType={null} onSelect={mockOnSelect} />);

    expect(screen.getByText('Select Agent Type')).toBeInTheDocument();
  });

  it('should show recommended badge on Claude Code', () => {
    render(<AgentTypeSelector selectedType={null} onSelect={mockOnSelect} />);

    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('should call onSelect when an agent type is clicked', () => {
    render(<AgentTypeSelector selectedType={null} onSelect={mockOnSelect} />);

    fireEvent.click(screen.getByText('Claude Code'));
    expect(mockOnSelect).toHaveBeenCalledWith('claude');

    fireEvent.click(screen.getByText('Cursor'));
    expect(mockOnSelect).toHaveBeenCalledWith('cursor');

    fireEvent.click(screen.getByText('Aider'));
    expect(mockOnSelect).toHaveBeenCalledWith('aider');
  });

  it('should highlight the selected agent type', () => {
    const { rerender } = render(
      <AgentTypeSelector selectedType="claude" onSelect={mockOnSelect} />
    );

    // Claude Code should be visually selected - use getAllByText and find the button
    const claudeTexts = screen.getAllByText('Claude Code');
    const claudeButton = claudeTexts[0].closest('button');
    // KIT redesign: selected state uses black border (was border-kanvas-blue)
    expect(claudeButton).toHaveClass('border-black');

    // Rerender with different selection
    rerender(<AgentTypeSelector selectedType="cursor" onSelect={mockOnSelect} />);

    const cursorTexts = screen.getAllByText('Cursor');
    const cursorButton = cursorTexts[0].closest('button');
    expect(cursorButton).toHaveClass('border-black');
  });

  it('should show description panel when agent type is selected', () => {
    render(<AgentTypeSelector selectedType="claude" onSelect={mockOnSelect} />);

    expect(screen.getByText('Full AI coding assistant with terminal access')).toBeInTheDocument();
  });

  it('should display launch method for each agent type', () => {
    render(<AgentTypeSelector selectedType={null} onSelect={mockOnSelect} />);

    // CLI appears for both Claude and Aider
    expect(screen.getAllByText('CLI').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('IDE')).toBeInTheDocument(); // Cursor
    expect(screen.getAllByText('VS Code').length).toBeGreaterThan(0); // Copilot, Cline
    expect(screen.getByText('Terminal')).toBeInTheDocument(); // Warp
    expect(screen.getByText('Manual')).toBeInTheDocument(); // Custom
  });

  it('should render in a grid layout', () => {
    render(<AgentTypeSelector selectedType={null} onSelect={mockOnSelect} />);

    // All agent type buttons should be in a grid
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(8); // 8 agent types (claude, cursor, copilot, cline, aider, warp, codex, custom)
  });

  describe('Agent Type Selection', () => {
    const agentTypes: { type: AgentType; name: string }[] = [
      { type: 'claude', name: 'Claude Code' },
      { type: 'cursor', name: 'Cursor' },
      { type: 'copilot', name: 'GitHub Copilot' },
      { type: 'cline', name: 'Cline' },
      { type: 'aider', name: 'Aider' },
      { type: 'warp', name: 'Warp' },
      { type: 'custom', name: 'Custom Agent' },
    ];

    agentTypes.forEach(({ type, name }) => {
      it(`should select ${name} when clicked`, () => {
        render(<AgentTypeSelector selectedType={null} onSelect={mockOnSelect} />);

        fireEvent.click(screen.getByText(name));
        expect(mockOnSelect).toHaveBeenCalledWith(type);
      });
    });
  });

  it('should not have any agent selected initially when selectedType is null', () => {
    render(<AgentTypeSelector selectedType={null} onSelect={mockOnSelect} />);

    // No description panel should be visible when nothing is selected
    expect(screen.queryByText('Full AI coding assistant with terminal access')).not.toBeInTheDocument();
  });
});
