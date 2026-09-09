/**
 * KITMark — official SeKondBrain KIT logomark.
 *
 * Renders the canonical brand asset (resources/kit-logomark.png — the
 * "Kit_Logomark_Mania" variant from brand.s9n.ai): a vertical-gradient sphere
 * (blue→purple→magenta) inside an open aurora ring, with KIT's distinct
 * ascending-diagonal three-dot configuration (Variant C) and the charcoal bezel.
 *
 * This replaces an earlier hand-drawn SVG approximation that did not match the
 * brand (radial sphere gradient, single 300° arc, no bezel, wrong dot config).
 *
 * NOTE on motion: the brand book defines per-component AI-state animations
 * (thinking = aurora breathes, working = ring orbits, speaking = sphere ripples).
 * Those isolate individual mark components and can't be driven from a flat PNG —
 * they need a layered SVG rebuilt to the official geometry. The `state` prop is
 * retained for API compatibility but currently renders the static mark.
 */

import React from 'react';

export type KITMarkState = 'idle' | 'thinking' | 'working' | 'speaking';

interface KITMarkProps {
  /** Rendered size in px (default 32) */
  size?: number;
  /** Retained for API compatibility; the static brand mark is rendered. */
  state?: KITMarkState;
  className?: string;
}

const KIT_MARK_SRC = new URL('../../../resources/kit-logomark.png', import.meta.url).href;

export function KITMark({ size = 32, state: _state = 'idle', className = '' }: KITMarkProps): React.ReactElement {
  return (
    <img
      src={KIT_MARK_SRC}
      width={size}
      height={size}
      alt="KIT"
      className={className}
      style={{ objectFit: 'contain', display: 'block' }}
      draggable={false}
    />
  );
}

/**
 * KITMarkContainer — wraps the KIT mark in a soft paper chip, matching the
 * sidebar icon-rail aesthetic.
 */
export function KITMarkContainer({
  size = 36,
  state = 'idle',
  className = '',
}: KITMarkProps): React.ReactElement {
  return (
    <div
      className={`flex items-center justify-center rounded-full bg-white flex-shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        border: '1px solid rgba(0,0,0,0.08)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      }}
    >
      {/* object-contain padding keeps the top-left dots from clipping the chip */}
      <KITMark size={Math.round(size * 0.82)} state={state} />
    </div>
  );
}
