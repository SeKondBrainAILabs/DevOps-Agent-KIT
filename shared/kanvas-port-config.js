/**
 * Kanvas Port Configuration Helper
 * 
 * Resolves KANVAS_PORT and KANVAS_PORT_RANGE environment variables
 * to determine the port Kanvas should bind to.
 * 
 * Port resolution logic:
 * - KANVAS_PORT is the preferred port Kanvas binds to
 * - If KANVAS_PORT is set and KANVAS_PORT_RANGE is unset, the preferred port is used directly
 * - If KANVAS_PORT_RANGE is set, the port is constrained to that range
 * - If neither is set, defaults to 5173 (with range 5173-5183)
 * 
 * @returns PortConfig object with port and range
 */
export function getPortConfig() {
  // Default values
  const DEFAULT_PORT = 5173;
  const DEFAULT_RANGE_START = 5173;
  const DEFAULT_RANGE_END = 5183;

  // Parse KANVAS_PORT if set
  let preferredPort = DEFAULT_PORT;
  if (process.env.KANVAS_PORT) {
    const portStr = process.env.KANVAS_PORT.trim();
    const portNum = parseInt(portStr, 10);
    if (!isNaN(portNum)) {
      preferredPort = portNum;
    }
  }

  // Parse KANVAS_PORT_RANGE if set
  let rangeStart = DEFAULT_RANGE_START;
  let rangeEnd = DEFAULT_RANGE_END;
  
  if (process.env.KANVAS_PORT_RANGE) {
    const rangeStr = process.env.KANVAS_PORT_RANGE.trim();
    // Match start-end pattern with possible whitespace around the dash
    const match = rangeStr.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    
    if (match) {
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      
      // Validate range
      if (!isNaN(start) && !isNaN(end) && start <= end) {
        rangeStart = start;
        rangeEnd = end;
      }
    }
  }

  return {
    port: preferredPort,
    range: {
      start: rangeStart,
      end: rangeEnd
    }
  };
}