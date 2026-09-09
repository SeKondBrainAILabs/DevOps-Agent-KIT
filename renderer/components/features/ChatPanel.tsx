/**
 * ChatPanel Component
 * AI chat interface with streaming support
 */

import React, { useState, useRef, useEffect } from 'react';
import { useIpcSubscription } from '../../hooks/useIpcSubscription';
import type { ChatMessage } from '../../../shared/types';

interface ChatPanelProps {
  sessionId: string;
}

export function ChatPanel({ sessionId }: ChatPanelProps): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Subscribe to stream events
  useIpcSubscription(
    window.api.ai.onChunk,
    (chunk) => {
      setStreamingContent((prev) => prev + chunk);
    },
    []
  );

  useIpcSubscription(
    window.api.ai.onEnd,
    () => {
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: streamingContent,
          timestamp: new Date().toISOString(),
        },
      ]);
      setStreamingContent('');
      setIsStreaming(false);
    },
    [streamingContent]
  );

  useIpcSubscription(
    window.api.ai.onError,
    (error) => {
      console.error('AI stream error:', error);
      setIsStreaming(false);
      setStreamingContent('');
    },
    []
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsStreaming(true);
    setStreamingContent('');

    // Start streaming
    window.api.ai.startStream([...messages, userMessage]);
  };

  return (
    <div className="flex flex-col h-full bg-surface-secondary">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 py-8">
            <p className="text-lg mb-2">Welcome to Kora</p>
            <p className="text-sm">
              Ask me anything about your session or project
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${
              msg.role === 'user' ? 'justify-end' : 'justify-start'
            }`}
          >
            <div
              className={`
                max-w-[80%] px-4 py-2 rounded-lg selectable
                ${
                  msg.role === 'user'
                    ? 'bg-accent text-white'
                    : 'bg-surface-tertiary text-gray-200'
                }
              `}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}

        {/* Streaming message */}
        {isStreaming && streamingContent && (
          <div className="flex justify-start">
            <div className="max-w-[80%] px-4 py-2 rounded-lg bg-surface-tertiary text-gray-200">
              <p className="whitespace-pre-wrap">{streamingContent}</p>
              <span className="inline-block w-2 h-4 bg-accent animate-cursor ml-1" />
            </div>
          </div>
        )}

        {/* Loading indicator */}
        {isStreaming && !streamingContent && (
          <div className="flex justify-start">
            <div className="px-4 py-2 rounded-lg bg-surface-tertiary text-gray-400">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-[rgba(0,0,0,0.10)]">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            disabled={isStreaming}
            className="input flex-1"
          />
          <button
            type="submit"
            disabled={!input.trim() || isStreaming}
            className="btn-primary px-4"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
