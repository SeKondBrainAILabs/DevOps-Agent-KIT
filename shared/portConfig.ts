/**
 * Port configuration helper for Kanvas
 * Resolves KANVAS_PORT and KANVAS_PORT_RANGE environment variables
 */

export interface PortConfig {
  /** Preferred port to try first */
  preferredPort: number;
  /** Port range to constrain the search within */
  portRange: {
    start: number;
    end: number;
  };
}

/**
 * Get port configuration from environment variables
 * @returns PortConfig object with preferredPort and portRange
 */
export function getPortConfig(): PortConfig {
  // Default values
  const DEFAULT_PORT = 5173;
  const DEFAULT_RANGE_START = 5173;
  const DEFAULT_RANGE_END = 5183;

  // Parse KANVAS_PORT
  let preferredPort = DEFAULT_PORT;
  const kanvasPort = process.env.KANVAS_PORT;
  const kanvasPortWasSet = kanvasPort !== undefined && kanvasPort !== '';
  
  if (kanvasPortWasSet) {
    const portNum = Number(kanvasPort);
    if (!isNaN(portNum) && portNum > 0) {
      preferredPort = portNum;
    }
  }

  // Parse KANVAS_PORT_RANGE
  const portRange = { start: DEFAULT_RANGE_START, end: DEFAULT_RANGE_END };
  const kanvasPortRange = process.env.KANVAS_PORT_RANGE;
  const kanvasPortRangeWasSet = kanvasPortRange !== undefined && kanvasPortRange !== '';
  
  if (kanvasPortRangeWasSet) {
    const match = kanvasPortRange.match(/^(\d+)-(\d+)$/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      
      // Validate range: start and end must be positive numbers, start <= end
      if (!isNaN(start) && !isNaN(end) && start > 0 && end > 0 && start <= end) {
        portRange.start = start;
        portRange.end = end;
      }
    }
  }

  // If KANVAS_PORT was NOT set and KANVAS_PORT_RANGE was set, 
  // ensure preferredPort is within the range
  if (!kanvasPortWasSet && kanvasPortRangeWasSet) {
    if (preferredPort < portRange.start || preferredPort > portRange.end) {
      preferredPort = portRange.start;
    }
  }

  return { preferredPort, portRange };
}