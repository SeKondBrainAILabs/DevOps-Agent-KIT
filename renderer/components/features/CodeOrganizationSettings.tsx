/**
 * Code Organization Settings Component
 * Renders the Code Organization section in SettingsModal
 */

import React, { useState, useEffect } from 'react';

interface OrganizationConfig {
  enabled: boolean;
  structure: 'feature-folders' | 'flat' | 'custom';
  setupCompleted: boolean;
  setupCompletedAt?: string;
}

interface CodeOrganizationSettingsProps {
  repoPath: string;
}

export function CodeOrganizationSettings({ repoPath }: CodeOrganizationSettingsProps) {
  const [config, setConfig] = useState<OrganizationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentStructure, setCurrentStructure] = useState<'feature-folders' | 'flat' | 'custom'>('feature-folders');
  const [showWarning, setShowWarning] = useState(false);

  // Load configuration when repoPath changes
  useEffect(() => {
    if (!repoPath) {
      setConfig(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    
    window.api.contractRegistry.getOrganizationConfig(repoPath)
      .then(result => {
        if (result.success && result.data) {
          setConfig(result.data);
          setCurrentStructure(result.data.structure);
        } else {
          setError('Failed to load organization config');
        }
        setLoading(false);
      })
      .catch(err => {
        setError('Failed to load organization config');
        setLoading(false);
      });
  }, [repoPath]);

  // Handle saving configuration
  const handleSave = async () => {
    if (!repoPath || !config) return;

    try {
      const result = await window.api.contractRegistry.setOrganizationConfig(repoPath, {
        ...config,
        structure: currentStructure,
      });

      if (!result.success) {
        setError('Failed to save organization config');
      }
    } catch (err) {
      setError('Failed to save organization config');
    }
  };

  // Handle structure change with warning logic
  const handleStructureChange = (newStructure: 'feature-folders' | 'flat' | 'custom') => {
    if (currentStructure === 'feature-folders' && newStructure === 'flat') {
      // Show warning when switching from feature-folders to flat
      setShowWarning(true);
    } else {
      // Directly update if no warning needed
      setCurrentStructure(newStructure);
    }
  };

  // Accept warning
  const handleAcceptWarning = () => {
    setCurrentStructure('flat');
    setShowWarning(false);
  };

  // Decline warning
  const handleDeclineWarning = () => {
    setShowWarning(false);
    // Reset to previous value
    if (config) {
      setCurrentStructure(config.structure);
    }
  };

  // Render structure display text
  const getDisplayText = (structure: 'feature-folders' | 'flat' | 'custom') => {
    switch (structure) {
      case 'feature-folders': return 'Feature-based';
      case 'flat': return 'Flat layout';
      case 'custom': return 'Custom';
      default: return '';
    }
  };

  if (loading) {
    // Show loading state with fallback to default text
    return (
      <div className="mt-4">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Code Organization</div>
        <div className="text-sm text-gray-400">Loading organization configuration...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Code Organization</div>
        <div className="text-sm text-red-400">Error: {error}</div>
      </div>
    );
  }

  if (!repoPath) {
    return (
      <div className="mt-4">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Code Organization</div>
        <div className="text-sm text-gray-400">No repository selected</div>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Code Organization</div>
      
      <div className="text-sm mb-4">
        Current preference: <span className="font-semibold">{getDisplayText(currentStructure)}</span>
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="code-organization"
            value="feature-folders"
            checked={currentStructure === 'feature-folders'}
            onChange={() => handleStructureChange('feature-folders')}
            className="w-4 h-4 accent-accent"
          />
          <span>Feature-based</span>
        </label>
        
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="code-organization"
            value="flat"
            checked={currentStructure === 'flat'}
            onChange={() => handleStructureChange('flat')}
            className="w-4 h-4 accent-accent"
          />
          <span>Flat layout</span>
        </label>
        
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="code-organization"
            value="custom"
            checked={currentStructure === 'custom'}
            onChange={() => handleStructureChange('custom')}
            className="w-4 h-4 accent-accent"
          />
          <span>Custom</span>
        </label>
      </div>

      <button
        onClick={handleSave}
        className="mt-4 btn-primary w-full text-sm"
        disabled={!config}
      >
        Save Changes
      </button>

      {/* Warning Modal */}
      {showWarning && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-[rgba(0,0,0,0.10)] rounded-lg shadow-lg w-full max-w-md p-6">
            <h3 className="text-lg font-semibold mb-2">Warning: Switching to Flat Layout</h3>
            <p className="text-sm text-gray-600 mb-4">
              Switching to flat layout will reorganize your repository structure. This change cannot be undone automatically. 
              Are you sure you want to proceed?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleDeclineWarning}
                className="px-3 py-1.5 text-sm border border-[rgba(0,0,0,0.10)] rounded-md hover:bg-surface-secondary transition-colors"
              >
                Keep Current
              </button>
              <button
                onClick={handleAcceptWarning}
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
              >
                Switch to Flat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}