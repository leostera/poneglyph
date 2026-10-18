// Trusted local child. Account/preview credentials stay in memory and private
// IPC; never place them in stdout, files or reports. The SDK's legacy helpers
// also read the token from this child's private process environment.
const {createRequire} = require('node:module');
const {dirname, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const requireCf = createRequire(require.resolve('cf/package.json'));
const wrangler = requireCf('wrangler');
(async () => {
  // Pinned cf 1.0.0-beta.14 exports its existing credential/profile reader in
  // this bundled module. Use the CLI's active profile, not a second login.
  const cfRoot = dirname(require.resolve('cf/package.json'));
  const oauth = await import(pathToFileURL(resolve(cfRoot, 'dist/oauth-BUr8bPwo.mjs')).href);
  oauth.f(undefined, process.cwd());
  const token = await oauth.s();
  if (typeof token !== 'string' || token.length < 20) throw new Error('Credential unavailable');
  process.env.CLOUDFLARE_API_TOKEN = token;
  const dev = new wrangler.unstable_DevEnv();
  dev.on('reloadComplete', event => {
    if (event.config.name === 'poneglyph-validation-independent-write-operator') {
      process.send?.({type: 'private-preview-ready', proxyData: event.proxyData});
    }
  });
  const dispatch = dev.dispatch.bind(dev);
  dev.dispatch = event => {
    if (event.type === 'error') {
      const cause = event.cause, message = cause instanceof Error ? cause.message : '';
      console.log(JSON.stringify({stage: 'sdk-error', apiCode: typeof cause?.code === 'number' ? cause.code : null,
        auth: /auth|permission|credential|token/i.test(message), config: /config|option|invalid|compatibility/i.test(message)}));
      process.send?.({type: 'private-preview-startup-error'});
    }
    return dispatch(event);
  };
  const worker = await dev.startWorker({
    config: process.env.PONEGLYPH_WRITE_OPERATOR_CONFIG,
    dev: {remote: true, server: {hostname: '127.0.0.1', port: Number(process.env.PONEGLYPH_WRITE_OPERATOR_PORT)},
      inspector: false, liveReload: false,
      auth: {accountId: '0f436d2aabf1f872be90b8dd9d5715e6', apiToken: {apiToken: token}}},
  });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await worker.dispose(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('disconnect', stop);
})().catch(() => { console.error('Private preview startup failed'); process.exit(1); });
