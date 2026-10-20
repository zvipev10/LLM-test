const test = require('node:test');
const assert = require('node:assert/strict');

test('uses OAuth credentials and caches the token until its seconds-based expiry', async () => {
  process.env.GREEN_INVOICE_API_BASE = 'https://api.greeninvoice.co.il/api/v1';
  process.env.GREEN_INVOICE_API_ID = 'test-id';
  process.env.GREEN_INVOICE_API_SECRET = 'test-secret';
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/oauth/token')) {
      return new Response(JSON.stringify({ accessToken: 'test-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  };
  const { getMorningAccountingClassificationOptions } = require('../dist/services/morningClient');
  await getMorningAccountingClassificationOptions(true);
  await getMorningAccountingClassificationOptions(true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.morning.co/idp/v1/oauth/token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { grant_type: 'client_credentials', client_id: 'test-id', client_secret: 'test-secret' });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
});
