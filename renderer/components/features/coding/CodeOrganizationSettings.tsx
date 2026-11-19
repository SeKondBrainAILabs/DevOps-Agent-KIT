/**
 * Code Organization Settings Component
 * Displays and allows editing of a repository's code organization preference
 */

import React, { useState, useEffect, useCallback } from 'react';

interface OrganizationConfig {
  enabled: boolean;
  structure: 'feature-folders' | 'flat';
  setupCompleted: boolean;
}

interface CodeOrganizationSettingsProps {
  repoPath: string;
}

export function CodeOrganizationSettings({ repoPath }: CodeOrganizationSettingsProps) {
  const [currentConfig, setCurrentConfig] = useState<OrganizationConfig | null>(null);
  const [selectedStructure, setSelectedStructure] = useState<'feature-folders' | 'flat'>('feature-folders');
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [warningAction, setWarningAction] = useState<() => void>(() => {});

  // Load current organization config
  useEffect(() => {
    const loadConfig = async () => {
      if (!repoPath) {
        setLoading(false);
        return;
      }
      
      try {
        const result = await window.api.contractRegistry.getOrganizationConfig(repoPath);
        if (result.success && result.data) {
          setCurrentConfig(result.data);
          // Set selected structure to match current config on load
          setSelectedStructure(result.data.structure);
        }
      } catch (error) {
        console.error('Failed to load organization config:', error);
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, [repoPath]);

  // Handle saving the configuration
  const handleSave = async () => {
    if (!repoPath || !currentConfig || isSaving) return;
    
    setIsSaving(true);
    
    try {
      const result = await window.api.contractRegistry.setOrganizationConfig(repoPath, {
        structure: selectedStructure
      });
      
      if (result.success) {
        // Update current config after successful save
        setCurrentConfig({
          ...currentConfig,
          structure: selectedStructure
        });
      }
    } catch (error) {
      console.error('Failed to save organization config:', error);
    } finally {
      setIsSaving(false);
    }
  };

  // Handle changing structure with potential warning
  const handleChangeStructure = (value: 'feature-folders' | 'flat') => {
    // If switching from feature-folders to flat, show warning
    if (currentConfig?.structure === 'feature-folders' && value === 'flat') {
      setWarningAction(() => () => {
        setSelectedStructure(value);
        setShowWarning(false);
      });
      setShowWarning(true);
    } else {
      setSelectedStructure(value);
    }
  };

  // Cancel the warning
  const handleCancelWarning = () => {
    setShowWarning(false);
    // Reset to previous selection
    if (currentConfig) {
      setSelectedStructure(currentConfig.structure);
    }
  };

  // Render the current preference display text
  const renderCurrentPreference = () => {
    if (currentConfig?.structure === 'feature-folders') {
      return 'Feature-based';
    }
    return 'Flat';
  };

  // Determine if the save button should be enabled
  const isSaveEnabled = currentConfig && (selectedStructure !== currentConfig.structure);

  // Ensure button state is properly managed
  useEffect(() => {
    // This ensures proper state propagation when configs change
  }, [currentConfig, selectedStructure]);

  if (loading) {
    return <div className="text-gray-400">Loading...</div>;
  }

  // Handle case when no repo is selected
  if (!repoPath) {
    return (
      <div className="bg-surface-secondary rounded-[14px] border border-[rgba(0,0,0,0.10)] p-3 space-y-3">
        <div className="text-xs text-gray-500 uppercase tracking-wide">Code Organization</div>
        <div className="text-gray-400">Select a repository to configure code organization</div>
      </div>
    );
  }

  return (
    <div className="bg-surface-secondary rounded-[14px] border border-[rgba(0,0,0,0.10)] p-3 space-y-3">
      <div className="text-xs text-gray-500 uppercase tracking-wide">Code Organization</div>
      
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-primary">Current Preference</span>
          <span 
            data-testid="current-preference"
            className="text-sm font-medium"
          >
            {renderCurrentPreference()}
          </span>
        </div>
        
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-primary">Change Preference</span>
          <select
            data-testid="org-structure-select"
            value={selectedStructure}
            onChange={(e) => handleChangeStructure(e.target.value as 'feature-folders' | 'flat')}
            className="select text-sm"
          >
            <option value="feature-folders">Feature-based</option>
            <option value="flat">Flat</option>
          </select>
        </div>
      </div>
      
      <button
        data-testid="save-button"
        onClick={handleSave}
        disabled={isSaving || !isSaveEnabled}
        className="btn-primary w-full py-2 text-sm"
      >
        {isSaving ? 'Saving...' : 'Save Changes'}
      </button>

      {/* Warning Dialog */}
      {showWarning && (
        <div data-testid="warning-dialog" className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white border border-[rgba(0,0,0,0.10)] rounded-[22px] shadow-[0_4px_6px_rgba(0,0,0,0.08)] w-full max-w-sm p-4">
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-100">Warning</h3>
                <p className="text-sm text-gray-500 mt-1">
                  Switching to flat structure will reorganize your repository. This action may cause issues with existing files and configurations.
                </p>
              </div>
              
              <div className="flex gap-2 justify-end">
                <button
                  data-testid="cancel-change"
                  onClick={handleCancelWarning}
                  className="px-3 py-1.5 text-sm rounded-md border border-[rgba(0,0,0,0.10)] hover:bg-surface-tertiary"
                >
                  Cancel
                </button>
                <button
                  data-testid="confirm-change"
                  onClick={warningAction}
                  className="px-3 py-1.5 text-sm rounded-md bg-red-600 hover:bg-red-700 text-white"
                >
                  Confirm Change
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}