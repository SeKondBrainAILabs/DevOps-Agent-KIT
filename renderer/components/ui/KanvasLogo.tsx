/**
 * KanvasLogo Component
 * Displays the Kanvas logo consistently across the app
 */

import React from 'react';

interface KanvasLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  withBackground?: boolean;
}

const sizeMap = {
  sm: { container: 'w-6 h-6', icon: 'w-4 h-4' },
  md: { container: 'w-8 h-8', icon: 'w-5 h-5' },
  lg: { container: 'w-10 h-10', icon: 'w-6 h-6' },
  xl: { container: 'w-24 h-24', icon: 'w-14 h-14' },
};

export function KanvasLogo({
  size = 'md',
  className = '',
  withBackground = true
}: KanvasLogoProps): React.ReactElement {
  const sizes = sizeMap[size];

  // Use the actual PNG logo for better quality
  const logoSrc = new URL('../../../resources/icon.png', import.meta.url).href;

  if (withBackground) {
    return (
      <div className={`${sizes.container} rounded-xl overflow-hidden flex-shrink-0 ${className}`}>
        <img
          src={logoSrc}
          alt="KIT"
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return (
    <img
      src={logoSrc}
      alt="KIT"
      className={`${sizes.container} rounded-xl object-cover flex-shrink-0 ${className}`}
    />
  );
}

/**
 * KanvasLogoSVG - Pure SVG version for when image loading isn't ideal
 * Simplified representation of the Kanvas logo
 */
export function KanvasLogoSVG({
  size = 'md',
  className = ''
}: Omit<KanvasLogoProps, 'withBackground'>): React.ReactElement {
  const sizes = sizeMap[size];

  return (
    <div className={`${sizes.container} rounded-xl bg-gradient-to-br from-kanvas-blue to-sk-blue-light flex items-center justify-center flex-shrink-0 ${className}`}>
      <svg
        viewBox="0 0 100 100"
        className={sizes.icon}
        fill="none"
      >
        {/* Outer ring */}
        <circle
          cx="50"
          cy="50"
          r="35"
          stroke="white"
          strokeWidth="8"
          fill="none"
        />
        {/* Break in ring (top-right) */}
        <path
          d="M 75 25 A 35 35 0 0 1 85 50"
          stroke="white"
          strokeWidth="8"
          strokeLinecap="round"
          fill="none"
          opacity="0"
        />
        {/* Center dot */}
        <circle
          cx="50"
          cy="50"
          r="12"
          fill="white"
        />
        {/* Sparkle dots */}
        <circle cx="25" cy="20" r="4" fill="white" opacity="0.8" />
        <circle cx="35" cy="15" r="2.5" fill="white" opacity="0.6" />
        <circle cx="45" cy="12" r="1.5" fill="white" opacity="0.4" />
      </svg>
    </div>
  );
}
