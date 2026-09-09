/**
 * InstructionsModal Component
 * Displays setup instructions after creating an agent instance
 */

import React, { useEffect, useState } from 'react';
import type { AgentInstance } from '../../../shared/types';

interface InstructionsModalProps {
  instance: AgentInstance;
  onClose: () => void;
}

type ViewMode = 'prompt' | 'instructions';

export function InstructionsModal({ instance, onClose }: InstructionsModalProps): React.ReactElement {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('prompt');

  // Live status: the prop-`instance` is a snapshot captured at create time and
  // never updates. Poll the IPC every 3s so the banner reflects actual state.
  const [liveStatus, setLiveStatus] = useState<AgentInstance['status']>(instance.status);
  // Sibling hint: when our status stays 'waiting' AND there's recent MCP
  // activity on another session in the same repo, surface it as a clickable
  // hint. The classic case: user pasted a new session's prompt into a Codex
  // window already attached to a different session, so the agent stays bound
  // to the OLD session and the new session never gets a connection.
  const [sibling, setSibling] = useState<{ sessionId: string; branchName: string; lastActivity: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await window.api?.instance?.get(instance.id);
        if (cancelled) return;
        if (r?.success && r.data) {
          setLiveStatus(r.data.status);
        }
      } catch { /* non-fatal */ }
    };
    refresh();
    const id = setInterval(refresh, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [instance.id]);

  useEffect(() => {
    // Only look for siblings while we're still waiting — once we're idle/active,
    // the agent has clearly connected and the hint becomes noise.
    if (liveStatus !== 'waiting') {
      setSibling(null);
      return;
    }
    if (!instance.sessionId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await window.api?.instance?.findActiveSibling?.(instance.sessionId!);
        if (cancelled) return;
        setSibling(r?.success ? r.data : null);
      } catch { /* non-fatal */ }
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [instance.sessionId, liveStatus]);

  const handleCopyPrompt = async () => {
    if (instance.prompt) {
      await navigator.clipboard.writeText(instance.prompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    }
  };

  const handleCopyAll = async () => {
    if (instance.instructions) {
      await navigator.clipboard.writeText(instance.instructions);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    }
  };

  const handleOpenTerminal = async () => {
    const path = instance.worktreePath || instance.config.repoPath;
    try {
      await window.api?.shell?.openTerminal(path);
    } catch (err) {
      console.error('Failed to open terminal:', err);
    }
  };

  const handleOpenVSCode = async () => {
    const path = instance.worktreePath || instance.config.repoPath;
    try {
      await window.api?.shell?.openVSCode(path);
    } catch (err) {
      console.error('Failed to open VS Code:', err);
    }
  };

  const handleOpenFinder = async () => {
    const path = instance.worktreePath || instance.config.repoPath;
    try {
      await window.api?.shell?.openFinder(path);
    } catch (err) {
      console.error('Failed to open Finder:', err);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div className="modal-backdrop" onClick={onClose} />

      {/* Modal */}
      <div className="modal w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[rgba(0,0,0,0.10)]">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-green-100 flex items-center justify-center">
              <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Agent Instance Created!</h2>
              <p className="text-sm text-text-secondary">
                Copy the prompt below and paste it into your coding agent to start
              </p>
            </div>
          </div>
        </div>

        {/* Status bar */}
        <div className="px-6 py-3 bg-surface-secondary border-b border-[rgba(0,0,0,0.10)] flex items-center justify-between">
          <div className="flex items-center gap-4">
            {liveStatus === 'waiting' || liveStatus === 'initializing' ? (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                <span className="text-sm text-text-secondary">Waiting for agent to connect…</span>
              </div>
            ) : liveStatus === 'failed' ? (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-sm text-text-secondary">Agent failed to start</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-sm text-text-secondary">Agent connected — {liveStatus}</span>
              </div>
            )}
            <span className="text-xs text-text-secondary/60">
              Session: {instance.sessionId?.slice(0, 12)}…
            </span>
          </div>

          {/* View toggle */}
          <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-tertiary">
            <button
              onClick={() => setViewMode('prompt')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === 'prompt'
                  ? 'bg-kanvas-blue text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              Prompt
            </button>
            <button
              onClick={() => setViewMode('instructions')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === 'instructions'
                  ? 'bg-kanvas-blue text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              Full Setup
            </button>
          </div>
        </div>

        {/* Cross-session gotcha hint: we're still waiting but a sibling session
            in the same repo has recent MCP activity → most likely the user
            pasted this prompt into a Codex window already attached to that
            sibling. The agent stays bound to its first session, so this one
            never gets a connection. */}
        {liveStatus === 'waiting' && sibling && (
          <div className="px-6 py-3 bg-amber-50 border-b border-amber-200 text-sm text-amber-900">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p>
                  An agent is currently active on <span className="font-mono">{sibling.branchName}</span> in this repo.
                </p>
                <p className="text-xs text-amber-800/80 mt-0.5">
                  Each session needs its own agent window. If you pasted this prompt into a Codex/Claude window already
                  attached to another KIT session, the agent stays bound to that one — open a fresh window for this session
                  and paste the prompt there.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Content */}
        {viewMode === 'prompt' && instance.prompt ? (
          <PromptView prompt={instance.prompt} onCopy={handleCopyPrompt} copied={copiedPrompt} />
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="prose prose-sm max-w-none">
              <InstructionsRenderer markdown={instance.instructions || ''} />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[rgba(0,0,0,0.10)] flex items-center justify-between bg-white">
          <div className="flex items-center gap-2">
            {instance.prompt && (
              <button
                type="button"
                onClick={handleCopyPrompt}
                className="btn-primary"
              >
                {copiedPrompt ? (
                  <>
                    <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Prompt Copied!
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                    Copy Prompt
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={handleCopyAll}
              className="kb-btn"
            >
              {copiedAll ? 'All Copied!' : 'Copy Full Instructions'}
            </button>
            <button
              type="button"
              onClick={handleOpenTerminal}
              className="kb-btn"
              title="Open terminal at project path"
            >
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Terminal
            </button>
            <button
              type="button"
              onClick={handleOpenVSCode}
              className="kb-btn"
              title="Open project in VS Code"
            >
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
              VS Code
            </button>
            <button
              type="button"
              onClick={handleOpenFinder}
              className="kb-btn"
              title="Open in Finder"
            >
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              Finder
            </button>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
          >
            Done
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * PromptView - Displays the comprehensive prompt with easy copy
 */
function PromptView({
  prompt,
  onCopy,
  copied
}: {
  prompt: string;
  onCopy: () => void;
  copied: boolean;
}): React.ReactElement {
  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Instructions */}
      <div className="px-6 py-4 bg-kanvas-blue/5 border-b border-kanvas-blue/20">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-kanvas-blue/10 flex items-center justify-center flex-shrink-0">
            <span className="text-kanvas-blue font-bold text-sm">1</span>
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">Copy this entire prompt</p>
            <p className="text-xs text-text-secondary mt-0.5">
              Click the button below or select all (Cmd+A) and copy (Cmd+C)
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 mt-3">
          <div className="w-8 h-8 rounded-lg bg-kanvas-blue/10 flex items-center justify-center flex-shrink-0">
            <span className="text-kanvas-blue font-bold text-sm">2</span>
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">Paste into your coding agent</p>
            <p className="text-xs text-text-secondary mt-0.5">
              Start your coding agent and paste this as your first message
            </p>
          </div>
        </div>
      </div>

      {/* Prompt content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="relative">
          {/* Copy button floating */}
          <button
            onClick={onCopy}
            className={`
              absolute top-2 right-2 z-10 px-4 py-2 rounded-lg font-medium text-sm
              flex items-center gap-2 transition-all
              ${copied
                ? 'bg-green-500 text-white'
                : 'bg-kanvas-blue text-white hover:bg-kanvas-blue-dark'
              }
            `}
          >
            {copied ? (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
                Copy Prompt
              </>
            )}
          </button>

          {/* The actual prompt */}
          <pre className="p-4 pr-32 rounded-xl bg-gray-900 text-gray-100 overflow-x-auto text-xs font-mono whitespace-pre-wrap leading-relaxed">
            {prompt}
          </pre>
        </div>
      </div>
    </div>
  );
}

/**
 * Simple markdown renderer for instructions
 */
function InstructionsRenderer({ markdown }: { markdown: string }): React.ReactElement {
  // Split by code blocks and render
  const parts = markdown.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-4">
      {parts.map((part, index) => {
        if (part.startsWith('```')) {
          // Code block
          const match = part.match(/```(\w*)\n?([\s\S]*?)```/);
          const language = match?.[1] || '';
          const code = match?.[2]?.trim() || '';

          return (
            <CodeBlock key={index} code={code} language={language} />
          );
        }

        // Regular markdown
        return (
          <div key={index} className="markdown-content">
            {part.split('\n').map((line, lineIndex) => {
              // Headings
              if (line.startsWith('## ')) {
                return <h2 key={lineIndex} className="text-lg font-semibold text-text-primary mt-6 mb-3">{line.slice(3)}</h2>;
              }
              if (line.startsWith('### ')) {
                return <h3 key={lineIndex} className="text-base font-medium text-text-primary mt-4 mb-2">{line.slice(4)}</h3>;
              }

              // Lists
              if (line.match(/^\d+\.\s/)) {
                const content = line.replace(/^\d+\.\s/, '');
                return (
                  <div key={lineIndex} className="flex gap-2 ml-4">
                    <span className="text-kanvas-blue font-medium">{line.match(/^\d+/)?.[0]}.</span>
                    <span className="text-text-primary">{renderInlineCode(content)}</span>
                  </div>
                );
              }
              if (line.startsWith('- ')) {
                return (
                  <div key={lineIndex} className="flex gap-2 ml-4">
                    <span className="text-text-secondary">•</span>
                    <span className="text-text-primary">{renderInlineCode(line.slice(2))}</span>
                  </div>
                );
              }

              // Horizontal rule
              if (line === '---') {
                return <hr key={lineIndex} className="border-border my-4" />;
              }

              // Bold text
              if (line.startsWith('**') && line.endsWith('**')) {
                return <p key={lineIndex} className="font-semibold text-text-primary">{line.slice(2, -2)}</p>;
              }

              // Regular paragraph
              if (line.trim()) {
                return <p key={lineIndex} className="text-text-primary">{renderInlineCode(line)}</p>;
              }

              return null;
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Render inline code within text
 */
function renderInlineCode(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);

  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={index} className="px-1.5 py-0.5 bg-surface-tertiary rounded text-sm font-mono text-kanvas-blue">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

/**
 * Code block with copy button
 */
function CodeBlock({ code, language }: { code: string; language: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group">
      <div className="absolute top-2 right-2 z-10">
        <button
          type="button"
          onClick={handleCopy}
          className="px-2 py-1 rounded-lg bg-surface/80 backdrop-blur text-xs font-medium
                   text-text-secondary hover:text-text-primary hover:bg-surface
                   opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"
        >
          {copied ? (
            <>
              <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="p-4 rounded-xl bg-gray-900 text-gray-100 overflow-x-auto text-sm font-mono">
        <code>{code}</code>
      </pre>
      {language && (
        <span className="absolute bottom-2 right-2 text-xs text-text-secondary/40">
          {language}
        </span>
      )}
    </div>
  );
}
