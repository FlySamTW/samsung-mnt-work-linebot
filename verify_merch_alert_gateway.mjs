import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./MerchAlert.gs', import.meta.url), 'utf8');
const scriptProperties = new Map([
  ['MNT_ALERT_GROUP_ID', `C${'1'.repeat(32)}`],
  ['MNT_ALERT_SECRET', 'local-test-secret-with-more-than-32-characters'],
  ['MNT_ALERT_MONTHLY_LIMIT', '200'],
  ['MNT_ALERT_RESERVED_QUOTA', '40']
]);
const pushes = [];
let quotaUsage = 20;

const byteArray = buffer => Array.from(buffer, value => value > 127 ? value - 256 : value);
const utilities = {
  Charset: { UTF_8: 'UTF_8' },
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  computeHmacSha256Signature(value, secret) {
    return byteArray(crypto.createHmac('sha256', secret).update(value, 'utf8').digest());
  },
  computeDigest(_algorithm, value) {
    return byteArray(crypto.createHash('sha256').update(value, 'utf8').digest());
  },
  base64EncodeWebSafe(bytes) {
    return Buffer.from(bytes.map(value => (value + 256) % 256)).toString('base64url');
  }
};

const response = (status, body, headers = {}) => ({
  getResponseCode: () => status,
  getContentText: () => JSON.stringify(body),
  getAllHeaders: () => headers
});

const context = {
  console,
  Date,
  JSON,
  Math,
  Number,
  Object,
  String,
  Array,
  RegExp,
  encodeURIComponent,
  Utilities: utilities,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: key => scriptProperties.get(key) || null,
      setProperty: (key, value) => scriptProperties.set(key, String(value))
    })
  },
  LockService: {
    getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
  },
  UrlFetchApp: {
    fetch(url, options = {}) {
      if (url.endsWith('/quota')) return response(200, { type: 'limited', value: 200 });
      if (url.endsWith('/quota/consumption')) return response(200, { totalUsage: quotaUsage });
      if (url.includes('/members/count')) return response(200, { count: 4 });
      if (url.endsWith('/message/push')) {
        pushes.push({ url, options, body: JSON.parse(options.payload) });
        return response(200, {}, { 'x-line-request-id': 'test-request-id' });
      }
      throw new Error(`unexpected URL: ${url}`);
    }
  },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: text => ({
      text,
      setMimeType() { return this; }
    })
  },
  getToken: () => 'test-token',
  writeLog() {}
};

vm.createContext(context);
vm.runInContext(source, context);

function signedPayload(overrides = {}) {
  const payload = {
    kind: 'mnt-alert-v1',
    timestamp: Date.now(),
    eventId: 'test-event-1',
    category: 'field_critical',
    message: '測試通知',
    dryRun: false,
    ...overrides
  };
  payload.signature = context.signMntAlertRequest_(payload, scriptProperties.get('MNT_ALERT_SECRET'));
  return payload;
}

function handle(payload) {
  return JSON.parse(context.handleMntAlertRequest_(payload).text);
}

const invalid = handle({ ...signedPayload(), signature: 'invalid' });
assert.equal(invalid.ok, false);
assert.equal(pushes.length, 0);

const dryRun = handle(signedPayload({ eventId: 'dry-run', dryRun: true }));
assert.equal(dryRun.ok, true);
assert.equal(dryRun.dryRun, true);
assert.equal(dryRun.expectedCost, 4);
assert.equal(pushes.length, 0);

const sent = handle(signedPayload());
assert.equal(sent.ok, true);
assert.equal(sent.sent, true);
assert.equal(pushes.length, 1);
assert.equal(pushes[0].body.to, scriptProperties.get('MNT_ALERT_GROUP_ID'));
assert.match(pushes[0].options.headers['X-Line-Retry-Key'], /^[0-9a-f-]{36}$/);

const duplicate = handle(signedPayload());
assert.equal(duplicate.ok, true);
assert.equal(duplicate.duplicate, true);
assert.equal(pushes.length, 1);

quotaUsage = 170;
const reserved = handle(signedPayload({ eventId: 'reserved', category: 'progress' }));
assert.equal(reserved.ok, false);
assert.match(reserved.error, /保留給系統故障通知/);
assert.equal(pushes.length, 1);

const emergency = handle(signedPayload({ eventId: 'emergency', category: 'system_down' }));
assert.equal(emergency.ok, true);
assert.equal(pushes.length, 2);

console.log('LINEBOT merch alert gateway verification passed');
