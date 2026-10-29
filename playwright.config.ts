import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser', fullyParallel:!process.env.ORBITDESK_BASE_URL, workers:process.env.ORBITDESK_BASE_URL?1:undefined, timeout:30000,
  expect:{timeout:6000}, reporter:'list',
  use:{baseURL:process.env.ORBITDESK_BASE_URL || 'http://127.0.0.1:4174',channel:'chrome',headless:true,trace:'retain-on-failure'},
  webServer:process.env.ORBITDESK_BASE_URL?undefined:{command:'"C:/Users/anubh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe" tests/browser/demo-server.mjs',url:'http://127.0.0.1:4174',reuseExistingServer:!process.env.CI}
});
