import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./Sales.js', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('./Main.js', import.meta.url), 'utf8');
const logs = [];
const properties = new Map();
let failNewAccess = false;

const dutyHeaders = [
  '時間戳記', '訊息ID', '使用者名稱', '店點', '類型',
  '初始台數', '結束台數', '三星台數', '記錄時間'
];

function makeSheet(name) {
  const sheet = {
    name,
    header: dutyHeaders.slice(),
    data: [],
    frozenRows: 0,
    maxColumns: 26,
    getMaxColumns() { return this.maxColumns; },
    insertColumnsAfter(column, count) {
      assert.equal(column, this.maxColumns);
      this.maxColumns += count;
    },
    getLastRow() {
      return this.data.length + 1;
    },
    insertRowBefore(row) {
      assert.equal(row, 2);
      this.data.unshift(Array(dutyHeaders.length).fill(''));
    },
    deleteRow(row) {
      assert.ok(row >= 2 && row <= this.data.length + 1);
      this.data.splice(row - 2, 1);
    },
    setFrozenRows(count) {
      this.frozenRows = count;
    },
    getRange(row, column, rowCount = 1, columnCount = 1) {
      const owner = this;
      const range = {
        getValues() {
          const values = [];
          for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
            const sheetRow = row + rowOffset;
            const sourceRow = sheetRow === 1 ? owner.header : (owner.data[sheetRow - 2] || []);
            values.push(Array.from(
              { length: columnCount },
              (_, columnOffset) => sourceRow[column - 1 + columnOffset] ?? ''
            ));
          }
          return values;
        },
        setValues(values) {
          values.forEach((nextRow, rowOffset) => {
            const sheetRow = row + rowOffset;
            const target = sheetRow === 1 ? owner.header : (owner.data[sheetRow - 2] ||= []);
            nextRow.forEach((value, columnOffset) => {
              target[column - 1 + columnOffset] = value;
            });
          });
          return range;
        },
        setNumberFormat() { return range; },
        setBackground() { return range; },
        setFontColor() { return range; },
        setFontWeight() { return range; }
      };
      return range;
    }
  };
  return sheet;
}

const legacySheet = makeSheet('銷售群組');
const newSheet = makeSheet('LINE勤務');
const memberSheet = makeSheet('群組&姓名對應');
const activitySheet = makeSheet('活動支援設定');
activitySheet.header = ['activity_id', 'name', 'start_date', 'end_date', 'latitude', 'longitude', 'radius_m', 'active'];
const legacyWorkbook = {
  getSheetByName: name => ({ 銷售群組: legacySheet, '群組&姓名對應': memberSheet, 活動支援設定: activitySheet })[name] || null
};
const newWorkbook = {
  getSheetByName: name => name === 'LINE勤務' ? newSheet : null,
  insertSheet: name => {
    assert.equal(name, 'LINE勤務');
    return newSheet;
  }
};

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
  Set,
  isNaN,
  SALES_SHEET_NAME: '銷售群組',
  SpreadsheetApp: {
    getActiveSpreadsheet: () => legacyWorkbook,
    openById: id => {
      assert.equal(id, '1dNJxwn8HaY6dnGh7pogsoscg6Oo3nVfW8wxpLNGv2Q4');
      if (failNewAccess) throw new Error('simulated new Sheet outage');
      return newWorkbook;
    },
    flush: () => {}
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value)
    })
  },
  LockService: {
    getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
  },
  Utilities: {
    getUuid: () => '00000000-0000-4000-8000-000000000001',
    formatDate: (date, zone, format) => {
      assert.equal(zone, 'Asia/Taipei');
      assert.equal(format, 'yyyy-MM-dd');
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
  },
  getValidStoreNames: () => ['測試店', '測試店2', '順發竹北'],
  getDisplayName: () => '未綁定人員',
  writeLog: message => logs.push(message)
};

vm.createContext(context);
vm.runInContext(source, context);

assert.equal(context.parseNumber('12'), 12);
assert.equal(context.parseNumber('12台'), 12);
assert.equal(context.parseNumber('0'), 0);
assert.equal(context.parseNumber('-1'), null);
assert.equal(context.parseNumber('1.5'), null);
assert.equal(context.parseNumber('12abc'), null);
assert.equal(context.getSalesDutyWriteMode_(), 'DUAL', '未設定時必須預設雙寫');
assert.equal(context.enableSalesDutyDualWrite(), 'DUAL', '編輯器管理入口必須能明確設為雙寫');
assert.equal(properties.get('SALES_DUTY_WRITE_MODE'), 'DUAL');

const now = Date.now();
legacySheet.data = [
  [new Date(now - 60_000), 'arrival', '測試人員', '測試店', '到點', 14]
];
assert.equal(context.checkStartReport('測試人員', '測試店'), null);

// 順發竹北歷史別名必須視為同一店；新寫入一律使用正式名稱。
assert.equal(context.normalizeSalesStoreName_('新竹順發'), '順發竹北');
assert.equal(context.normalizeSalesStoreName_('竹北順發'), '順發竹北');
assert.equal(context.normalizeSalesStoreName_('順發 竹北店'), '順發竹北');
assert.equal(context.normalizeSalesStoreName_('新竹竹北'), '順發竹北');
legacySheet.data = [[new Date(now - 60_000), 'hsinchu-arrival', '王聖華', '新竹順發', '到點', 3]];
assert.equal(
  context.checkStartReport('王聖華', '順發竹北'),
  null,
  '舊名稱到點後，使用新名稱下班仍必須成功配對'
);
const canonicalRow = context.buildSalesDutyRow_(now, 'canonical-store', '王聖華', '竹北順發', '下班', null, 2, 1);
assert.equal(canonicalRow[3], '順發竹北', '新勤務列只可寫入正式店名');
legacySheet.data = [[new Date(now - 60_000), 'arrival-restored', '測試人員', '測試店', '到點', 14]];

// 2026/08/20 正式現場案例：到點 14、下班 12、Samsung 2 必須允許。
// 既有 LINE 輸入只以下班總台數作為占比分母，不與到點初始台數相減。
const checkout = context.analyzeCheckOut(
  ['下班', '測試店', '12', '2'],
  { isValid: false, needResponse: false },
  '測試人員'
);
assert.equal(checkout.isValid, true);
assert.equal(checkout.endCount, 12);
assert.equal(checkout.samsungCount, 2);
assert.ok(Math.abs(checkout.salesRatio - (100 / 6)) < 1e-10);

legacySheet.data = [[new Date(now - 60_000), 'arrival-2', '測試人員2', '測試店2', '到點', 1]];
const allSamsungCheckout = context.analyzeCheckOut(
  ['下班', '測試店2', '2', '2'],
  { isValid: false, needResponse: false },
  '測試人員2'
);
assert.equal(allSamsungCheckout.isValid, true);
assert.equal(allSamsungCheckout.salesRatio, 100);
assert.match(context.generateResponse(allSamsungCheckout, '測試人員2'), /今日銷售佔比為 100\.0%/);

legacySheet.data = [[new Date(now - 60_000), 'arrival-3', '測試人員', '測試店', '到點', 0]];
const samsungOverTotal = context.analyzeCheckOut(
  ['下班', '測試店', '1', '2'],
  { isValid: false, needResponse: false },
  '測試人員'
);
assert.equal(samsungOverTotal.isValid, false);
assert.match(samsungOverTotal.message, /不能大於下班總台數/);

const zeroDeltaReply = context.generateResponse({
  type: '下班',
  endCount: 0,
  samsungCount: 0,
  salesRatio: 0
}, '測試人員');
assert.match(zeroDeltaReply, /當班全店無銷售任何螢幕/);

legacySheet.data = [];
const missingStart = context.checkStartReport('測試人員', '測試店');
assert.match(missingStart, /請先報到/);

// DUAL：同一事件寫入新舊兩表，且相同 messageId 重送不得重複。
legacySheet.data = [];
newSheet.data = [];
properties.delete('SALES_DUTY_WRITE_MODE');
assert.equal(context.recordSalesData(now, 'dual-message', 'user-id', '測試人員', '測試店', '下班', null, 20, 4), true);
assert.equal(legacySheet.data.length, 1);
assert.equal(newSheet.data.length, 1);
assert.equal(legacySheet.data[0].length, 9, '舊銷售群組仍維持固定 9 欄');
assert.equal(newSheet.data[0].length, 9, '新 LINE勤務 亦須固定 9 欄');
assert.deepEqual(
  Array.from(legacySheet.data[0].slice(1, 8)),
  ['dual-message', '測試人員', '測試店', '下班', null, 20, 4]
);
assert.equal(context.recordSalesData(now, 'dual-message', 'user-id', '測試人員', '測試店', '下班', null, 20, 4), true);
assert.equal(legacySheet.data.length, 1, '舊表重送不得重複');
assert.equal(newSheet.data.length, 1, '新表重送不得重複');

// 正式煙霧測試必須先讀回兩表，最後再按唯一 messageId 清除且確認無殘留。
const legacyCountBeforeSmoke = legacySheet.data.length;
const newCountBeforeSmoke = newSheet.data.length;
const smokeResult = context.smokeTestSalesDutyDualWrite();
assert.equal(smokeResult.cleaned, true);
assert.match(smokeResult.messageId, /^codex-duty-smoke-/);
assert.equal(legacySheet.data.length, legacyCountBeforeSmoke);
assert.equal(newSheet.data.length, newCountBeforeSmoke);

// 新表暫時失敗不得中斷正在營運的舊 LINE 流程。
legacySheet.data = [];
newSheet.data = [];
failNewAccess = true;
assert.equal(context.recordSalesData(now, 'new-outage', 'user-id', '測試人員', '測試店', '到點', 10, null, null), true);
assert.equal(legacySheet.data.length, 1);
assert.equal(newSheet.data.length, 0);
assert.ok(logs.some(message => message.includes('Sales dual-write pending') && message.includes('new-outage')));
failNewAccess = false;

// 切換 NEW_ONLY 前先把 8/1 起舊表資料補齊；之後驗證與寫入均只使用新表。
legacySheet.data = [
  [new Date(now - 60_000), 'cutover-arrival', '切換測試員', '切換店', '到點', 8, null, null, new Date(now - 60_000)]
];
newSheet.data = [];
assert.equal(context.setSalesDutyWriteMode('NEW_ONLY'), 'NEW_ONLY');
assert.equal(properties.get('SALES_DUTY_WRITE_MODE'), 'NEW_ONLY');
assert.equal(newSheet.data.length, 1, '切換前必須補齊來源列');
assert.equal(context.checkStartReport('切換測試員', '切換店'), null, 'NEW_ONLY 必須改讀新表');
const oldCountBeforeNewOnly = legacySheet.data.length;
assert.equal(context.recordSalesData(now, 'new-only-checkout', 'user-id', '切換測試員', '切換店', '下班', null, 8, 2), true);
assert.equal(legacySheet.data.length, oldCountBeforeNewOnly, 'NEW_ONLY 不得再寫舊表');
assert.equal(newSheet.data.length, 2, 'NEW_ONLY 必須寫新表');

assert.throws(() => context.setSalesDutyWriteMode('INVALID'), /僅接受 DUAL 或 NEW_ONLY/);
assert.match(source, /getRange\(1,\s*4,\s*lastRow,\s*2\)/, 'LINE 姓名仍須固定只讀 D:E');
assert.match(mainSource, /getRange\("G2:G"\s*\+\s*sheet\.getLastRow\(\)\)/, '店點白名單仍須固定讀 G');

// 活動支援：同一固定店名下，身分、日期與活動 ID 必須各自正確。
function memberRow(userId, reporterId, active, name) {
  const row = Array(13).fill('');
  row[3] = userId; // D
  row[4] = name + ' LINE 名稱'; // E
  row[6] = '原店名不可改'; // G
  row[7] = reporterId; // H
  row[8] = active; // I
  row[10] = name; // K
  return row;
}
memberSheet.data = [
  memberRow('line-a', 'S001', true, '正式人員甲'),
  memberRow('line-b', 'S002', 'TRUE', '正式人員乙'),
  memberRow('line-c', 'S003', '1', '正式人員丙'),
  memberRow('line-disabled', 'S004', false, '停用人員'),
  memberRow('line-blank-active', 'S005', '', '未啟用人員'),
  memberRow('line-no-reporter', '', true, '未設定銷售ID'),
  memberRow('line-test', 'test', true, '測試帳號'),
  memberRow('line-temporary', 'temporary_123', true, '臨時帳號')
];
const originalMembers = JSON.stringify(memberSheet.data);
const activityTime = Date.parse('2026-10-22T09:00:00+08:00');
legacySheet.data = [];
newSheet.data = [];
properties.set('SALES_DUTY_WRITE_MODE', 'DUAL');
let settingsReads = 0;
const originalLookup = legacyWorkbook.getSheetByName;
legacyWorkbook.getSheetByName = name => {
  if (name === '活動支援設定') { settingsReads += 1; throw Error('There is no activity settings sheet'); }
  return originalLookup(name);
};
assert.equal(context.salesActivityDateKey_('2026-02-30'), '');
for (const user of ['line-disabled', 'line-blank-active', 'line-no-reporter', 'line-test', 'line-temporary', 'unknown']) {
  assert.match(context.processSalesGroupMessage(activityTime, 'blocked-' + user, user, '到點/活動支援/0'), /正式銷售人員/);
}
assert.equal(legacySheet.data.length, 0);
assert.match(context.processSalesGroupMessage(activityTime, 'generic-arrival-a', 'line-a', '到點/活動支援/14'), /正式人員甲 上班打卡成功/);
assert.equal(legacySheet.data[0].length, 11);
assert.deepEqual(Array.from(legacySheet.data[0].slice(9)), ['SALES_ACTIVITY_SUPPORT', '活動支援']);
assert.deepEqual(Array.from(legacySheet.header.slice(0, 9)), dutyHeaders);
assert.deepEqual(Array.from(newSheet.header.slice(9)), ['activity_id', 'activity_name_snapshot']);
assert.match(context.processSalesGroupMessage(activityTime, 'generic-duplicate-a', 'line-a', '到點/活動支援/14'), /報到過了/);
assert.equal(legacySheet.data.length, 1);
assert.match(context.processSalesGroupMessage(activityTime, 'generic-no-arrival', 'line-b', '下班/活動支援/12/2'), /請先報到/);
assert.match(context.processSalesGroupMessage(activityTime, 'generic-arrival-b', 'line-b', '到點/活動支援/14'), /上班打卡成功/);
assert.match(context.processSalesGroupMessage(activityTime, 'generic-arrival-c', 'line-c', '到點/活動支援/14'), /上班打卡成功/);
for (const user of ['line-a', 'line-b', 'line-c']) {
  const reply = context.processSalesGroupMessage(activityTime + 9 * 3600_000, 'generic-out-' + user, user, '下班/活動支援/12/2');
  assert.match(reply, /下班打卡成功/);
  assert.match(reply, /今日活動現場累計：總台數 12、三星 2/);
  assert.match(reply, /個人成交請填銷售回報表/);
  assert.doesNotMatch(reply, /活動支援｜活動支援/);
}
assert.equal(legacySheet.data.filter(row => row[4] === '下班').length, 3);
assert.ok(legacySheet.data.filter(row => row[4] === '下班').every(row => row[6] === 12 && row[7] === 2));
assert.equal(newSheet.data.length, legacySheet.data.length);
assert.match(context.processSalesGroupMessage(activityTime + 86400_000, 'generic-next-day-out', 'line-a', '下班/活動支援/2/1'), /請先報到/);
const beforeInvalid = legacySheet.data.length;
assert.match(context.processSalesGroupMessage(activityTime, 'generic-over-total', 'line-a', '下班/活動支援/1/2'), /不能大於下班總台數/);
assert.match(context.processSalesGroupMessage(activityTime, 'generic-negative', 'line-a', '下班/活動支援/-1/0'), /數字格式/);
assert.match(context.processSalesGroupMessage(activityTime, 'generic-extra-fields', 'line-a', '到點/活動支援/EXPO_A/0'), /正確格式/);
assert.equal(legacySheet.data.length, beforeInvalid);
const later = Date.parse('2026-12-09T09:00:00+08:00');
assert.match(context.processSalesGroupMessage(later, 'generic-later-month', 'line-a', '到點/活動支援/0'), /上班打卡成功/);
assert.match(context.processSalesGroupMessage(later + 3600_000, 'generic-later-month-out', 'line-a', '下班/活動支援/3/1'), /下班打卡成功/);
assert.equal(legacySheet.data[0][9], 'SALES_ACTIVITY_SUPPORT');
newSheet.data = [];
const sync = context.syncSalesDutyHistoryToNew();
assert.equal(sync.missingAfter, 0);
assert.equal(newSheet.data.length, legacySheet.data.length);
const beforeNewOnly = legacySheet.data.length;
context.setSalesDutyWriteMode('NEW_ONLY');
assert.match(context.processSalesGroupMessage(activityTime, 'generic-new-only', 'line-a', '下班/活動支援/0/0'), /下班打卡成功/);
assert.equal(legacySheet.data.length, beforeNewOnly);
assert.equal(newSheet.data[0][9], 'SALES_ACTIVITY_SUPPORT');
context.enableSalesDutyDualWrite();
failNewAccess = true;
assert.match(context.processSalesGroupMessage(activityTime, 'generic-new-outage', 'line-a', '下班/活動支援/12/2'), /下班打卡成功/);
failNewAccess = false;
context.syncSalesDutyHistoryToNew();
assert.equal(newSheet.data.filter(row => row[1] === 'generic-new-outage').length, 1);
assert.equal(settingsReads, 0, 'Generic support never reads event configuration');
assert.equal(JSON.stringify(memberSheet.data), originalMembers);

const collisionSheet = makeSheet('collision');
collisionSheet.header[9] = '既有其他欄位';
assert.throws(() => context.writeSalesDutyRow_(collisionSheet, [new Date(activityTime), 'collision', '甲', '活動支援', '到點', 0, null, null, new Date(), 'EXPO_A', '展場']), /拒絕覆寫/);
assert.equal(collisionSheet.data.length, 0);
const narrowSheet = makeSheet('narrow');
narrowSheet.maxColumns = 9;
context.writeSalesDutyRow_(narrowSheet, [new Date(activityTime), 'narrow', '甲', '活動支援', '到點', 0, null, null, new Date(), 'EXPO_A', '展場']);
assert.equal(narrowSheet.maxColumns, 11, '窄表須先增欄才能安全附加活動欄位');
assert.equal(narrowSheet.data[0][9], 'EXPO_A');

console.log('Sales shift verification passed: legacy rules, dual-write, generic support without setup, identity and date isolation, shared snapshots and safe schema extension.');
