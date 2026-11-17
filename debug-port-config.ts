import { getPortConfig } from './shared/portConfig.js';

// Test basic functionality
process.env.KANVAS_PORT = '6000';
console.log('KANVAS_PORT=6000:');
console.log(getPortConfig());

// Reset and test default
delete process.env.KANVAS_PORT;
console.log('\nDefault:');
console.log(getPortConfig());

// Test range 
process.env.KANVAS_PORT_RANGE = '5200-5210';
console.log('\nWith KANVAS_PORT_RANGE=5200-5210:');
console.log(getPortConfig());