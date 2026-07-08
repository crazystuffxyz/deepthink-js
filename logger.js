// logger.js
'use strict';

export const C = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  blue: '\x1b[34m'
};

export function stageBanner(msg) {
  console.log(`\n${C.magenta}=========================================${C.reset}`);
  console.log(`${C.cyan}${msg}${C.reset}`);
  console.log(`${C.magenta}=========================================${C.reset}\n`);
}

export function writeToken(token) {
  process.stdout.write(token);
}