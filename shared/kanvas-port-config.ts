/**
 * Resolves KANVAS_PORT and KANVAS_PORT_RANGE environment variables
 * 
 * KANVAS_PORT is the preferred port Kanvas binds to.
 * KANVAS_PORT_RANGE defines the range within which the port should be kept.
 * 
 * When KANVAS_PORT is set:
 * - If KANVAS_PORT_RANGE is also set, the port will be validated to be within that range
 * - If KANVAS_PORT_RANGE is not set, the port is used as-is (no range validation)
 * 
 * When neither is set, defaults to port 5173 with range 5173-5183.
 * 
 * @returns Object with port, rangeStart, and rangeEnd properties
 */
export function resolveKanvasPort(): { port: number; rangeStart: number; rangeEnd: number } {
  // Default port and range
  const DEFAULT_PORT = 5173;
  const DEFAULT_RANGE_START = 5173;
  const DEFAULT_RANGE_END = 5183;
  
  // Parse KANVAS_PORT
  let port: number = DEFAULT_PORT;
  if (process.env.KANVAS_PORT) {
    const portStr = process.env.KANVAS_PORT.trim();
    const parsedPort = parseInt(portStr, 10);
    if (!isNaN(parsedPort)) {
      port = parsedPort;
    }
  }
  
  // Parse KANVAS_PORT_RANGE
  let rangeStart = DEFAULT_RANGE_START;
  let rangeEnd = DEFAULT_RANGE_END;
  
  if (process.env.KANVAS_PORT_RANGE) {
    const rangeStr = process.env.KANVAS_PORT_RANGE.trim();
    const rangeMatch = rangeStr.match(/^(\d+)-(\d+)$/);
    
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      
      // Only accept valid ranges where start <= end
      if (!isNaN(start) && !isNaN(end)) {
        rangeStart = start;
        rangeEnd = end;
      }
    }
  }
  
  return {
    port,
    rangeStart,
    rangeEnd
  };
}