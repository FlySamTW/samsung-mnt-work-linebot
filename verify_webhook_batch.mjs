import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function sheet(header = []) {
  const rows = [header.slice()];
  return {
    rows, getLastRow: () => rows.length, getMaxColumns: () => 26,
    setFrozenRows() {}, deleteRows(start, count) { rows.splice(start - 1, count); },
    insertRowBefore(row) { rows.splice(row - 1, 0, []); },
    getRange(row, col, height = 1, width = 1) {
      if (typeof row === 'string') {
        assert.match(row, /^G2:G\d+$/);
        row = 2; col = 7; height = rows.length - 1;
      }
      return {
        getValues: () => Array.from({ length: height }, (_, y) =>
          Array.from({ length: width }, (_, x) => rows[row - 1 + y]?.[col - 1 + x] ?? '')),
        setValues(values) { values.forEach((r, y) => r.forEach((v, x) => {
          rows[row - 1 + y] ??= []; rows[row - 1 + y][col - 1 + x] = v;
        })); },
        setNumberFormat() {}, setBackground() { return this; },
        setFontColor() { return this; }, setFontWeight() { return this; }
      };
    }
  };
}
function harness() {
  const headers = ['時間戳記', '訊息ID', '使用者名稱', '店點', '類型', '初始台數', '結束台數', '三星台數', '記錄時間'];
  const legacy = sheet(headers), current = sheet(headers), all = sheet([]), log = sheet([]);
  const members = sheet(Array(13).fill(''));
  for (const [id, name, store] of [['qa-a', '測試甲', '台中良興'], ['qa-b', '測試乙', '高雄順發']]) {
    const row = Array(13).fill(''); row[3] = id; row[4] = name; row[6] = store; members.rows.push(row);
  }
  const replies = [], consoleLogs = [];
  let flushCount = 0;
  const workbook = { getSheetByName: name => ({ ALL: all, LOG: log, 銷售群組: legacy, '群組&姓名對應': members })[name] || null };
  const context = vm.createContext({
    Date, console: { log: text => consoleLogs.push(text) },
    HtmlService: { createHtmlOutput: text => ({ text }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => workbook,
      openById: () => ({ getSheetByName: name => name === 'LINE勤務' ? current : null }),
      flush: () => { flushCount++; }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) },
    UrlFetchApp: { fetch(url, options) {
      if (url.includes('/profile/')) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ displayName: '測試LINE' }) };
      assert.ok(url.endsWith('/message/reply'), 'tests cannot call any other external endpoint');
      replies.push(JSON.parse(options.payload));
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    } }
  });
  for (const file of ['Main.js', 'Sales.js', 'Reminder.js']) vm.runInContext(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), context);
  let gatewayCalls = 0;
  context.isMntAlertPayload_ = payload => payload.kind === 'mnt-alert-v1';
  context.handleMntAlertRequest_ = () => { gatewayCalls++; return { text: 'GATEWAY' }; };
  const post = events => context.doPost({ postData: { contents: JSON.stringify({ events }) } });
  return { context, legacy, current, all, log, members, replies, consoleLogs, post, flushCount: () => flushCount, gatewayCalls: () => gatewayCalls };
}
function text(id, user = 'qa-a', message = '到點/台中良興/5台', extra = {}) {
  return { type: 'message', timestamp: Date.now(), message: { id, type: 'text', text: message, quoteToken: 'NEVER_LOG_QUOTE', markAsReadToken: 'NEVER_LOG_READ' },
    replyToken: 'NEVER_LOG_REPLY_' + id, source: { type: 'group', groupId: 'Ceef408d9179d98e7cc0bcb028a16d86b', userId: user }, ...extra };
}
const image = { type: 'message', message: { id: 'qa-photo', type: 'image' } };
const cases = [];
{
  const h = harness();
  const batch = [image, text('qa-arrival-a'), image, text('qa-arrival-b', 'qa-b', '到點/高雄順發/3台')];
  assert.equal(h.post(batch).text, 'OK');
  for (const s of [h.legacy, h.current]) {
    assert.equal(s.rows.length, 3, JSON.stringify({ logs: h.log.rows, replies: h.replies }));
    assert.deepEqual(s.rows.slice(1).map(r => r[1]).sort(), ['qa-arrival-a', 'qa-arrival-b']);
  }
  assert.equal(h.all.rows.length, 3);
  assert.equal(h.replies.length, 2);
  assert.match(h.replies[0].messages[0].text, /測試甲 上班打卡成功/);
  assert.match(h.replies[1].messages[0].text, /測試乙 上班打卡成功/);
  assert.ok(h.flushCount() <= 12, 'ordinary batch must not flush one debug row per whitelist cell');
  assert.doesNotMatch(JSON.stringify([h.consoleLogs, h.log.rows]), /NEVER_LOG_(QUOTE|READ|REPLY)/);
  h.post(batch);
  h.post(batch.map(e => ({ ...e, deliveryContext: { isRedelivery: true } })));
  assert.equal(h.replies.length, 2);
  assert.equal(h.current.rows.length, 3);
  cases.push('photo/text/photo/text: both people saved and replied; repeated batch adds nothing');
}
{
  const h = harness();
  h.post([text('qa-existing')]);
  h.post([text('qa-existing'), text('qa-new-person', 'qa-b', '到點/高雄順發/3台')]);
  assert.equal(h.replies.length, 2);
  assert.equal(h.current.rows.length, 3);
  cases.push('existing first message does not stop a later new person');
}
{
  const h = harness();
  h.post([null, {}, { type: 'message' }, { type: 'follow' }, { type: 'message', message: { type: 'text' } }, text('qa-after-invalid')]);
  assert.equal(h.replies.length, 1);
  assert.equal(h.current.rows.length, 2);
  cases.push('malformed and unsupported events do not block later text');
}
{
  const h = harness(), original = h.context.processMessage;
  h.context.processMessage = e => { if (e.message.id === 'qa-throw') throw Error('simulated one-event failure'); return original(e); };
  h.post([text('qa-throw'), text('qa-survivor', 'qa-b', '到點/高雄順發/3台')]);
  assert.equal(h.replies.length, 1);
  assert.equal(h.current.rows[1][1], 'qa-survivor');
  cases.push('one handler failure does not block another person');
}
{
  const h = harness(), event = text('qa-unseen-redelivery', 'qa-a', '到點/台中良興/5台', { deliveryContext: { isRedelivery: true } });
  h.post([event]); h.post([event]);
  assert.equal(h.current.rows.length, 2);
  assert.equal(h.replies.length, 1);
  h.post([text('qa-new-report-same-person')]);
  assert.equal(h.current.rows.length, 2, 'another message ID must still respect same-person same-day duplicate arrival');
  assert.match(h.replies.at(-1).messages[0].text, /報到過了/);
  cases.push('previously unseen redelivery is accepted once; same-day duplicate attendance still blocked');
}
{
  const h = harness();
  h.post([text('qa-chat', 'qa-a', '收到'), { ...text('qa-edit'), type: 'messageEdited' }]);
  assert.equal(h.replies.length, 0);
  assert.equal(h.current.rows.length, 1);
  assert.equal(h.all.rows.length, 2);
  assert.equal(h.context.doPost({ postData: { contents: '{}' } }).text, 'OK');
  assert.equal(h.context.doPost({ postData: { contents: JSON.stringify({ events: {} }) } }).text, 'OK');
  assert.equal(h.context.doPost({ postData: { contents: JSON.stringify({ kind: 'mnt-alert-v1', events: [text('qa-gateway')] }) } }).text, 'GATEWAY');
  assert.equal(h.gatewayCalls(), 1);
  cases.push('ordinary chat stays silent; edits do not rewrite attendance; signed gateway remains separate');
}
console.log(JSON.stringify({ passed: true, cases, externalRequests: 0, productionWrites: 0 }, null, 2));
