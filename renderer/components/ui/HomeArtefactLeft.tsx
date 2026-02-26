/**
 * HomeArtefactLeft Component
 * Hero card with gradient blur background, SeKondBrain wordmark, and "Kit Dev Ops" title.
 * Figma: Kanvas / Home_Artefact_Left (node 1390:34430)
 */

import React from 'react';

interface HomeArtefactLeftProps {
  className?: string;
  onClick?: () => void;
}

/**
 * Subtle multi-layered gradient background with frosted glass blur.
 * Reproduces the Figma "Gradient & Blur" group using design token colors.
 */
function GradientBlur(): React.ReactElement {
  return (
    <div className="absolute inset-0">
      {/* Base white + subtle color gradients at the edges */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: [
            'linear-gradient(237deg, transparent 1%, transparent 50%, rgba(230, 184, 0, 0.1) 99%)',
            'linear-gradient(144deg, transparent 12%, transparent 50%, rgba(226, 74, 242, 0.1) 88%)',
            'linear-gradient(204deg, transparent 13%, transparent 50%, rgba(26, 138, 246, 0.1) 87%)',
            'linear-gradient(90deg, #ffffff 0%, #ffffff 100%)',
          ].join(', '),
        }}
      />
      {/* Frosted glass overlay */}
      <div className="absolute inset-0 backdrop-blur-[100px] bg-surface/40" />
    </div>
  );
}

export function HomeArtefactLeft({
  className = '',
  onClick,
}: HomeArtefactLeftProps): React.ReactElement {
  const logoSrc = new URL('../../../resources/logo-with-name.png', import.meta.url).href;

  return (
    <div
      className={`
        bg-surface rounded-lg overflow-hidden relative cursor-pointer
        w-full h-full min-h-[400px]
        ${className}
      `}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      <GradientBlur />

      {/* SeKondBrain wordmark logo */}
      <div className="absolute top-12 left-12">
        <img
          src={logoSrc}
          alt="SeKondBrain"
          className="h-10 w-auto object-contain pointer-events-none"
        />
      </div>

      {/* Title */}
      <div className="absolute bottom-12 left-12">
        <p className="text-8xl xl:text-9xl font-medium text-text-primary leading-none tracking-[-0.04em]">
          Kit
        </p>
        <p className="text-8xl xl:text-9xl font-medium text-text-primary leading-none tracking-[-0.04em]">
          Dev Ops
        </p>
      </div>
    </div>
  );
}
