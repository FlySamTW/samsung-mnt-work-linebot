import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(new URL('./MerchAlert.gs', import.meta.url), 'utf8');
const scriptProperties = new Map([
  ['MNT_ALERT_GROUP_ID', `C${'1'.repeat(32)}`],
  ['MNT_ALERT_SECRET', 'local-test-secret-with-more-than-32-characters'],
  ['MNT_ALERT_MONTHLY_LIMIT', '200'],
  ['MNT_ALERT_RESERVED_QUOTA', '40']
]);
const pushes = [];
const allMessageLogs = [];
let allMessageLogShouldFail = false;
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
  },
  formatDate(date, _timezone, format) {
    const value = new Date(date);
    const parts = new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    if (format === 'yyyyMM') return `${parts.year}${parts.month}`;
    if (format === 'MM/dd HH:mm') return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
    throw new Error(`unexpected date format: ${format}`);
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
  logAllMessages(...args) {
    allMessageLogs.push(args);
    if (allMessageLogShouldFail) throw new Error('simulated ALL write failure');
    return true;
  },
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

const longAnnouncement = context.normalizeMntAlertRequest_({
  kind: 'mnt-alert-v1',
  timestamp: Date.now(),
  eventId: 'long-announcement',
  category: 'feature_announcement',
  message: '商'.repeat(5000),
  dryRun: false,
  signature: 'not-used-for-normalization'
});
assert.equal(longAnnouncement.message.length, 4500, 'formal link report must fit below LINE 5000-character text limit without the old 1200-character truncation');

const invalid = handle({ ...signedPayload(), signature: 'invalid' });
assert.equal(invalid.ok, false);
assert.equal(pushes.length, 0);

const dryRun = handle(signedPayload({ eventId: 'dry-run', dryRun: true }));
assert.equal(dryRun.ok, true);
assert.equal(dryRun.suppressed, true);
assert.equal(dryRun.expectedCost, 0);
assert.equal(pushes.length, 0);

const sent = handle(signedPayload());
assert.equal(sent.ok, true);
assert.equal(sent.suppressed, true);
assert.equal(sent.expectedCost, 0);
assert.equal(pushes.length, 0);
assert.equal(allMessageLogs.length, 0);

const ordinaryPhotoAi = handle(signedPayload({
  eventId: 'ordinary-photo-ai',
  message: '【需主管留意｜現場回報】\nM001 測試門市｜測試人員\n問題：照片 AI 判定 FollowMe 或舊型號待確認'
}));
assert.equal(ordinaryPhotoAi.ok, true);
assert.equal(ordinaryPhotoAi.suppressed, true);
assert.equal(ordinaryPhotoAi.expectedCost, 0);
assert.equal(pushes.length, 0);
assert.equal(allMessageLogs.length, 0);

const trulyCritical = handle(signedPayload({
  eventId: 'truly-critical',
  message: '【需主管留意｜現場回報】\nM001 測試門市｜測試人員\n問題：定位距離異常'
}));
assert.equal(trulyCritical.ok, true);
assert.equal(trulyCritical.suppressed, true);
assert.equal(trulyCritical.replyOnly, true);
assert.equal(pushes.length, 0);
assert.equal(allMessageLogs.length, 0);

const taskMappingCritical = handle(signedPayload({
  eventId: 'task-mapping-critical',
  message: '【需主管留意｜現場回報】\nM002 測試門市｜測試人員\n問題：回報無法對應本月任務'
}));
assert.equal(taskMappingCritical.ok, true);
assert.equal(taskMappingCritical.suppressed, true);
assert.equal(pushes.length, 0);
assert.equal(allMessageLogs.length, 0);

const duplicate = handle(signedPayload({
  eventId: 'truly-critical',
  message: '【需主管留意｜現場回報】\nM001 測試門市｜測試人員\n問題：定位距離異常'
}));
assert.equal(duplicate.ok, true);
assert.equal(duplicate.suppressed, true);
assert.equal(pushes.length, 0);
assert.equal(allMessageLogs.length, 0);

const statusSnapshot = {
  v: 1,
  month: '202607',
  updatedAt: new Date().toISOString(),
  progress: { reported: 56, total: 280, percent: 20, unreported: 224 },
  issues: { photo: 3, gps: 2, task: 1, other: 0 },
  service: { status: 'ok', summary: '正常', checkedAt: new Date().toISOString() },
  links: {
    manager: 'https://script.google.com/macros/s/test/exec',
    fieldReport: 'https://mnt-field-report-wrapper.zeabur.app',
    guide: 'https://mnt-field-report-wrapper.zeabur.app/guide'
  }
};
const synced = handle(signedPayload({
  eventId: 'status-snapshot',
  category: 'status_snapshot',
  message: JSON.stringify(statusSnapshot)
}));
assert.equal(synced.ok, true);
assert.equal(synced.synced, true);
assert.equal(synced.expectedCost, 0);
assert.equal(pushes.length, 0);
assert.equal(allMessageLogs.length, 0);
const statusReply = context.buildMntMerchStatusReply_(scriptProperties.get('MNT_ALERT_GROUP_ID'));
assert.match(statusReply, /【2026\/07 MNT 商化摘要】/);
assert.match(statusReply, /進度：56 \/ 280 店（20%）/);
assert.match(statusReply, /待處理：6 項\n照片 3｜定位 2｜任務 1｜其他 0/);
assert.doesNotMatch(statusReply, /https?:\/\//);
assert.doesNotMatch(statusReply, /\?page=/);
assert.ok(statusReply.length <= 500);
assert.equal(context.buildMntMerchStatusReply_(`C${'2'.repeat(32)}`), '此指令只提供商化管理群組使用。');

quotaUsage = 170;
const reserved = handle(signedPayload({ eventId: 'reserved', category: 'progress' }));
assert.equal(reserved.ok, true);
assert.equal(reserved.suppressed, true);
assert.equal(pushes.length, 0);

const emergency = handle(signedPayload({ eventId: 'emergency', category: 'system_down' }));
assert.equal(emergency.ok, true);
assert.equal(pushes.length, 1);
assert.equal(allMessageLogs.length, 1);
assert.equal(pushes[0].body.to, scriptProperties.get('MNT_ALERT_GROUP_ID'));
assert.match(pushes[0].options.headers['X-Line-Retry-Key'], /^[0-9a-f-]{36}$/);
const downSnapshot = JSON.parse(scriptProperties.get('MNT_MERCH_STATUS_SNAPSHOT'));
assert.equal(downSnapshot.service.status, 'down');

quotaUsage = 20;
allMessageLogShouldFail = true;
const allLogFailure = handle(signedPayload({ eventId: 'all-log-failure', category: 'system_down' }));
assert.equal(allLogFailure.ok, true);
assert.equal(allLogFailure.sent, true);
assert.equal(allLogFailure.allLogSaved, false);
assert.equal(pushes.length, 2);
assert.equal(allMessageLogs.length, 2);
const allLogFailureDuplicate = handle(signedPayload({ eventId: 'all-log-failure', category: 'system_down' }));
assert.equal(allLogFailureDuplicate.duplicate, true);
assert.equal(pushes.length, 2);
assert.equal(allMessageLogs.length, 2);

scriptProperties.set('MNT_ALERT_PROACTIVE_MONTHLY_CAP', '8');
const capped = handle(signedPayload({ eventId: 'proactive-cap', category: 'system_recovered' }));
assert.equal(capped.ok, false);
assert.match(capped.error, /主動通知本月安全上限/);
assert.equal(pushes.length, 2);

function gitChangedPaths(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
      .split(/\r?\n/)
      .map(value => value.trim().replaceAll('\\', '/'))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function verifyRegressionLedger() {
  const ledgerRelativePath = 'REGRESSION_GUARDS.md';
  const ledgerPath = path.join(repoRoot, ledgerRelativePath);
  assert.ok(fs.existsSync(ledgerPath), 'missing LINE Bot regression guard ledger');
  const ledger = fs.readFileSync(ledgerPath, 'utf8');
  const entries = Array.from(ledger.matchAll(/^## (LB-RG-\d{3}) — .+$/gm));
  assert.ok(entries.length >= 3, 'LINE Bot regression ledger must retain all active message-safety corrections');
  assert.equal(new Set(entries.map(match => match[1])).size, entries.length, 'LINE Bot regression guard IDs must be unique');
  const requiredFields = ['日期', '症狀', '根因', '永久規則', '自動守門', '首次納入'];
  entries.forEach((entry, index) => {
    const bodyStart = entry.index + entry[0].length;
    const bodyEnd = index + 1 < entries.length ? entries[index + 1].index : ledger.length;
    const body = ledger.slice(bodyStart, bodyEnd);
    requiredFields.forEach(field => {
      assert.match(body, new RegExp(`^- ${field}：\\S.+$`, 'm'), `${entry[1]} missing ${field}`);
    });
  });

  const isProgram = filePath => new Set([
    'Main.js', 'MerchAlert.gs', 'Reminder.js', 'Sales.js', 'appsscript.json'
  ]).has(filePath);
  const workingChanges = Array.from(new Set([
    ...gitChangedPaths(['diff', '--name-only', 'HEAD']),
    ...gitChangedPaths(['ls-files', '--others', '--exclude-standard'])
  ]));
  const workingProgramChanges = workingChanges.filter(isProgram);
  if (workingProgramChanges.length > 0) {
    assert.ok(
      workingChanges.includes(ledgerRelativePath),
      `LINE Bot program changes require the regression ledger in the same working change:\n${workingProgramChanges.join('\n')}`
    );
  }

  const ledgerCommits = gitChangedPaths(['log', '-1', '--format=%H', '--', ledgerRelativePath]);
  if (ledgerCommits[0]) {
    const programChangesAfterLedger = gitChangedPaths(['diff', '--name-only', `${ledgerCommits[0]}..HEAD`]).filter(isProgram);
    assert.deepEqual(
      programChangesAfterLedger,
      [],
      `LINE Bot program changes were committed after the last regression ledger update:\n${programChangesAfterLedger.join('\n')}`
    );
  }
}

verifyRegressionLedger();

console.log('LINEBOT merch alert gateway verification passed');
