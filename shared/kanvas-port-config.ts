/**
 * Port configuration helper for Kanvas.
 * Reads KANVAS_PORT and KANVAS_PORT_RANGE environment variables and returns
 * the preferred port and range configuration.
 */

export interface KanvasPortConfig {
  port: number;
  range: {
    start: number;
    end: number;
  };
}

/**
 * Gets the port configuration for Kanvas based on environment variables.
 * 
 * @returns {KanvasPortConfig} Configuration with preferred port and range
 */
export function getKanvasPortConfig(): KanvasPortConfig {
  // Default range: 5173-5183 (inclusive)
  const DEFAULT_RANGE_START = 5173;
  const DEFAULT_RANGE_END = 5183;
  
  // Parse KANVAS_PORT environment variable
  const portStr = process.env.KANVAS_PORT;
  let preferredPort = portStr ? parseInt(portStr.trim(), 10) : undefined;
  
  // Parse KANVAS_PORT_RANGE environment variable
  const rangeStr = process.env.KANVAS_PORT_RANGE;
  let rangeStart = DEFAULT_RANGE_START;
  let rangeEnd = DEFAULT_RANGE_END;
  
  // Process range if provided
  if (rangeStr) {
    try {
      // Trim whitespace and validate range format (should be like "5200-5210")
      const trimmedRangeStr = rangeStr.trim();
      const match = trimmedRangeStr.match(/^(\d+)-(\d+)$/);
      
      if (match) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        
        // Validate range values
        if (!isNaN(start) && !isNaN(end) && start <= end) {
          rangeStart = start;
          rangeEnd = end;
        }
      }
    } catch (error) {
      // If parsing fails, fall back to default range
    }
  }
  
  // If KANVAS_PORT is not set, use start of range as preferred port
  if (preferredPort === undefined) {
    preferredPort = rangeStart;
  }
  
  return {
    port: preferredPort,
    range: {
      start: rangeStart,
      end: rangeEnd
    }
  };
}