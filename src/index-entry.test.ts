import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { shouldStartMainModule } from './index.js';

describe('server entry-point detection', () => {
  const serverPath = '/opt/koda/app/dist/index.js';
  const serverUrl = pathToFileURL(serverPath).href;

  it('starts when Node executes the server file directly', () => {
    expect(shouldStartMainModule(serverUrl, serverPath)).toBe(true);
  });

  it('stays idle when tests or another module import the server', () => {
    expect(
      shouldStartMainModule(
        serverUrl,
        '/opt/koda/app/node_modules/vitest/vitest.mjs',
      ),
    ).toBe(false);
  });

  it('starts when PM2 imports the configured server through its wrapper', () => {
    expect(
      shouldStartMainModule(
        serverUrl,
        '/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js',
        serverPath,
      ),
    ).toBe(true);
  });
});
