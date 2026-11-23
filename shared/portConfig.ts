/**
 * Port configuration helper that reads KANVAS_PORT and KANVAS_PORT_RANGE environment variables
 * Parses KANVAS_PORT as an integer for preferredPort
 * Parses KANVAS_PORT_RANGE as 'start-end' format for portRange
 * If preferredPort falls outside the parsed portRange, adjusts it to portRange.start
 * Returns { preferredPort, portRange: { start, end } }
 * On malformed inputs or missing env vars, falls back to defaults:
 *   preferredPort = 5173, portRange = { start: 5173, end: 5183 }
 */

export interface PortRange {
  start: number;
  end: number;
}

export interface PortConfig {
  preferredPort: number;
  portRange: PortRange;
}

export function getPortConfig(): PortConfig {
  // Default values
  let preferredPort = 5173;
  let portRange = { start: 5173, end: 5183 };
  let rangeSpecified = false;

  // Parse KANVAS_PORT if provided
  if (process.env.KANVAS_PORT) {
    const portStr = process.env.KANVAS_PORT.trim();
    if (portStr) {
      const parsedPort = parseInt(portStr, 10);
      if (!isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
        preferredPort = parsedPort;
      }
    }
  }

  // Parse KANVAS_PORT_RANGE if provided  
  if (process.env.KANVAS_PORT_RANGE) {
    const rangeStr = process.env.KANVAS_PORT_RANGE.trim();
    if (rangeStr) {
      const match = rangeStr.match(/^(\d+)-(\d+)$/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        if (!isNaN(start) && !isNaN(end) && start >= 1 && end <= 65535 && start <= end) {
          portRange = { start, end };
          rangeSpecified = true;
        }
      }
    }
  }

  // Only enforce range constraint if range was explicitly specified
  if (rangeSpecified) {
    if (preferredPort < portRange.start) {
      preferredPort = portRange.start;
    } else if (preferredPort > portRange.end) {
      preferredPort = portRange.start; // Use start of range as fallback when outside range
    }
  }

  return {
    preferredPort,
    portRange
  };
}