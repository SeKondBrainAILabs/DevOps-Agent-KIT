/**
 * Kanvas Port Configuration Helper
 * 
 * Reads KANVAS_PORT and KANVAS_PORT_RANGE environment variables
 * and returns the configured port and port range.
 * 
 * Rules:
 * - KANVAS_PORT is the preferred port Kanvas binds
 * - With KANVAS_PORT set and KANVAS_PORT_RANGE unset, the default range (5173-5183) applies
 * - KANVAS_PORT_RANGE, when set, defines the range (malformed values fall back to defaults)
 * - When KANVAS_PORT is unset but KANVAS_PORT_RANGE is set, the preferred port is the start of the range
 * - With neither set, defaults are port 5173 and range 5173-5183
 */

export interface PortRange {
  start: number;
  end: number;
}

export interface KanvasPortConfig {
  port: number;
  range: PortRange;
}

const DEFAULT_PORT = 5173;
const DEFAULT_RANGE_START = 5173;
const DEFAULT_RANGE_END = 5183;

/**
 * Parses a port range string in the format "start-end"
 * Returns undefined if the format is invalid or values are malformed
 */
function parseRange(rangeStr: string): PortRange | undefined {
  const trimmed = rangeStr.trim();
  
  // Check for exactly one dash separating two values
  const parts = trimmed.split('-');
  if (parts.length !== 2) {
    return undefined;
  }
  
  const startStr = parts[0].trim();
  const endStr = parts[1].trim();
  
  // Check both parts are non-empty and numeric
  if (!startStr || !endStr) {
    return undefined;
  }
  
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);
  
  // Check if parsing resulted in valid numbers
  if (isNaN(start) || isNaN(end)) {
    return undefined;
  }
  
  // Check that start <= end
  if (start > end) {
    return undefined;
  }
  
  return { start, end };
}

/**
 * Gets the Kanvas port configuration from environment variables.
 * 
 * This is a pure function - it only reads from process.env and returns
 * deterministic output based on those values.
 * 
 * @returns KanvasPortConfig with port and range
 */
export function getKanvasPortConfig(): KanvasPortConfig {
  const portEnv = process.env.KANVAS_PORT;
  const rangeEnv = process.env.KANVAS_PORT_RANGE;
  
  // Determine the port
  let port: number;
  if (portEnv !== undefined && portEnv.trim() !== '') {
    const parsedPort = parseInt(portEnv.trim(), 10);
    if (!isNaN(parsedPort)) {
      port = parsedPort;
    } else {
      // Invalid port number, fall back to default
      port = DEFAULT_PORT;
    }
  } else {
    // KANVAS_PORT not set, will be determined by range
    port = DEFAULT_PORT;
  }
  
  // Determine the range
  let range: PortRange;
  if (rangeEnv !== undefined && rangeEnv.trim() !== '') {
    const parsedRange = parseRange(rangeEnv);
    if (parsedRange) {
      range = parsedRange;
    } else {
      // Malformed range, fall back to default
      range = { start: DEFAULT_RANGE_START, end: DEFAULT_RANGE_END };
    }
  } else {
    // KANVAS_PORT_RANGE not set, use default range
    range = { start: DEFAULT_RANGE_START, end: DEFAULT_RANGE_END };
  }
  
  // If KANVAS_PORT is not set but KANVAS_PORT_RANGE is set,
  // use the start of the range as the preferred port
  if (portEnv === undefined || portEnv.trim() === '') {
    port = range.start;
  }
  
  return { port, range };
}
