/**
 * Renderer Process Entry Point
 * SeKondBrain Kanvas - React UI
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// Hide sentinel — bundle is executing
const sentinel = document.getElementById('js-sentinel');
if (sentinel) sentinel.style.display = 'none';

// Error boundary to surface production React rendering errors
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught:', error, info);
  }

  render() {
    if (this.state.error) {
      const err = this.state.error;
      return React.createElement('div', {
        style: {
          background: '#1a1a2e',
          color: '#e94560',
          fontFamily: 'monospace',
          fontSize: 14,
          padding: 40,
          whiteSpace: 'pre-wrap',
          position: 'fixed',
          inset: 0,
          overflow: 'auto',
        }
      },
        React.createElement('h2', null, 'React Rendering Error (ErrorBoundary)'),
        React.createElement('b', null, err.message),
        React.createElement('br'),
        React.createElement('br'),
        err.stack || '(no stack)'
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root');
if (!container) {
  document.body.innerHTML = '<div style="color:red;padding:40px;font-size:20px">Root element not found</div>';
  throw new Error('Root element not found');
}

const root = createRoot(container);
root.render(
  React.createElement(ErrorBoundary, null,
    React.createElement(React.StrictMode, null,
      React.createElement(App)
    )
  )
);
