import { getKanvasPortConfig } from './shared/kanvas-port-config';

// Mock environment variables for testing
process.env.KANVAS_PORT = undefined;
process.env.KANVAS_PORT_RANGE = '  6000-6050  ';

console.log('Testing range parsing...');

const result = getKanvasPortConfig();
console.log('Result:', result);