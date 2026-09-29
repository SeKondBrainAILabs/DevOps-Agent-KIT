/**
 * LanesHeader (KC-S2.1.7): the five model lanes and their health, from
 * harness_cluster_status, plus the DevOps Agent the harness drives.
 */

import React from 'react';
import { laneHealth, type HarnessClusterStatus, type LaneHealth } from '../../../../shared/harness-types';

const DOT: Record<LaneHealth, string> = {
  ok: 'bg-status-success',
  down: 'bg-status-error',
  unknown: 'bg-status-idle',
};

export function LanesHeader({ status }: { status: HarnessClusterStatus | null }): React.ReactElement {
  const lanes = laneHealth(status);
  const devops = status?.devops_agent;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="lanes-header" aria-label="Model lanes">
      {lanes.map((lane) => (
        <span
          key={lane.id}
          data-testid={`lane-${lane.id}`}
          data-health={lane.health}
          title={`${lane.alias}: ${lane.health}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs"
        >
          <span className={`h-2 w-2 rounded-full ${DOT[lane.health]}`} />
          {lane.id}
        </span>
      ))}
      <span
        data-testid="lane-devops"
        data-health={devops ? (devops.ok ? 'ok' : 'down') : 'unknown'}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs"
        title={devops?.url ?? 'DevOps Agent'}
      >
        <span className={`h-2 w-2 rounded-full ${DOT[devops ? (devops.ok ? 'ok' : 'down') : 'unknown']}`} />
        devops agent
      </span>
    </div>
  );
}
