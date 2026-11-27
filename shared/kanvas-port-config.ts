/**
 * Kanvas Port Configuration Helper
 * 
 * Resolves KANVAS_PORT and KANVAS_PORT_RANGE environment variables to determine
 * the preferred port and range for Kanvas to use.
 * 
 * @returns An object containing the selected port and range
 */
export function getKanvasPortConfig() {
  // Default range
  const DEFAULT_PORT = 5173;
  const DEFAULT_RANGE_START = 5173;
  const DEFAULT_RANGE_END = 5183;
  
  // Parse KANVAS_PORT environment variable
  const portStr = process.env.KANVAS_PORT;
  let port = null;
  if (portStr !== undefined && portStr.trim() !== '') {
    const parsed = parseInt(portStr.trim(), 10);
    if (!isNaN(parsed)) {
      port = parsed;
    }
  }
  
  // Parse KANVAS_PORT_RANGE environment variable
  const rangeStr = process.env.KANVAS_PORT_RANGE;
  let rangeStart = null;
  let rangeEnd = null;
  
  if (rangeStr !== undefined && rangeStr.trim() !== '') {
    try {
      const trimmedRange = rangeStr.trim();
      const parts = trimmedRange.split('-');
      
      // Validate format: should be exactly 2 parts (start-end)
      if (parts.length === 2) {
        const startStr = parts[0].trim();
        const endStr = parts[1].trim();
        
        // Check if both parts are numeric
        const startParsed = parseInt(startStr, 10);
        const endParsed = parseInt(endStr, 10);
        
        if (!isNaN(startParsed) && !isNaN(endParsed)) {
          // Validate that start <= end
          if (startParsed <= endParsed) {
            rangeStart = startParsed;
            rangeEnd = endParsed;
          }
        }
      }
    } catch (e) {
      // If parsing fails due to malformed range, fall back to defaults
    }
  }
  
  // If range is not properly set, use default range
  if (rangeStart === null || rangeEnd === null) {
    rangeStart = DEFAULT_RANGE_START;
    rangeEnd = DEFAULT_RANGE_END;
  }
  
  // Determine the preferred port
  let preferredPort;
  
  // If KANVAS_PORT is set, use it regardless of range
  if (port !== null) {
    preferredPort = port;
  } else if (rangeStart !== null) {
    // If KANVAS_PORT is not set but range is set, use start of range
    preferredPort = rangeStart;
  } else {
    // Fallback to default port
    preferredPort = DEFAULT_PORT;
  }
  
  return {
    port: preferredPort,
    range: {
      start: rangeStart,
      end: rangeEnd
    }
  };
}