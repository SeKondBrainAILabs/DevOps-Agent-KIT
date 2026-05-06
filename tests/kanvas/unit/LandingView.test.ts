/**
 * Unit Tests for L4 — Configurable default landing view
 */

import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_LANDING_VIEW,
  LANDING_VIEW_OPTIONS,
  isValidLandingView,
  resolveLandingView,
} from '../../../shared/landing-view';

describe('L4 — landing view defaults', () => {
  it('default is last-visited so users are not relocated unexpectedly', () => {
    expect(DEFAULT_LANDING_VIEW).toBe('last-visited');
  });

  it('exposes 3 options for the settings UI', () => {
    expect(LANDING_VIEW_OPTIONS).toHaveLength(3);
    const values = LANDING_VIEW_OPTIONS.map((o) => o.value);
    expect(values).toEqual(['morning-check', 'workspace-browser', 'last-visited']);
  });
});

describe('isValidLandingView (L4)', () => {
  it('accepts the three valid values', () => {
    expect(isValidLandingView('morning-check')).toBe(true);
    expect(isValidLandingView('workspace-browser')).toBe(true);
    expect(isValidLandingView('last-visited')).toBe(true);
  });
  it('rejects unknown / wrong-typed values', () => {
    expect(isValidLandingView('home')).toBe(false);
    expect(isValidLandingView('')).toBe(false);
    expect(isValidLandingView(null)).toBe(false);
    expect(isValidLandingView(42)).toBe(false);
  });
});

describe('resolveLandingView (L4)', () => {
  it('returns morning-check when configured', () => {
    expect(resolveLandingView({ configured: 'morning-check' })).toEqual({ view: 'morning-check' });
  });

  it('returns workspace-browser when configured', () => {
    expect(resolveLandingView({ configured: 'workspace-browser' })).toEqual({
      view: 'workspace-browser',
    });
  });

  it('last-visited + lastVisitedRoute → returns the saved route', () => {
    const out = resolveLandingView({
      configured: 'last-visited',
      lastVisitedRoute: '/repo/abc/branches',
    });
    expect(out).toEqual({ view: 'last-visited', route: '/repo/abc/branches' });
  });

  it('last-visited on first launch (no saved route) falls back to workspace-browser', () => {
    expect(resolveLandingView({ configured: 'last-visited' })).toEqual({
      view: 'workspace-browser',
    });
  });
});
