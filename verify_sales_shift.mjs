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
const legacyWorkbook = {
  getSheetByName: name => name === '銷售群組' ? legacySheet : null
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
    getUuid: () => '00000000-0000-4000-8000-000000000001'
  },
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

console.log('Sales shift verification passed.');
