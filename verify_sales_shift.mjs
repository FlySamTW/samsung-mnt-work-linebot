import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./Sales.js', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('./Main.js', import.meta.url), 'utf8');
let rows = [];
const writtenRows = [];
const logs = [];

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
  SALES_SHEET_NAME: '銷售群組',
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: () => ({
        getLastRow: () => rows.length + 1,
        insertRowBefore: () => {},
        getRange: (_row, _column, count) => ({
          getValues: () => rows.slice(0, count),
          setValues: values => writtenRows.push(...values),
          setNumberFormat: () => {}
        })
      })
    }),
    flush: () => {}
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

const now = Date.now();
rows = [
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

// 同日第二組正式案例：到點 1、下班 2、Samsung 2 必須回覆 100.0%。
rows = [[new Date(now - 60_000), 'arrival-2', '測試人員2', '測試店2', '到點', 1]];
const allSamsungCheckout = context.analyzeCheckOut(
  ['下班', '測試店2', '2', '2'],
  { isValid: false, needResponse: false },
  '測試人員2'
);
assert.equal(allSamsungCheckout.isValid, true);
assert.equal(allSamsungCheckout.salesRatio, 100);
assert.match(context.generateResponse(allSamsungCheckout, '測試人員2'), /今日銷售佔比為 100\.0%/);

rows = [[new Date(now - 60_000), 'arrival-3', '測試人員', '測試店', '到點', 0]];
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

rows = [];
const missingStart = context.checkStartReport('測試人員', '測試店');
assert.match(missingStart, /請先報到/);

assert.match(source, /getRange\(1,\s*4,\s*lastRow,\s*2\)/, 'LINE 姓名仍須固定只讀 D:E');
assert.match(mainSource, /getRange\("G2:G"\s*\+\s*sheet\.getLastRow\(\)\)/, '店點白名單仍須固定讀 G');
assert.equal(context.recordSalesData(Date.now(), 'message-id', 'user-id', '測試人員', '測試店', '下班', null, 20, 4), true);
assert.equal(writtenRows.length, 1);
assert.equal(writtenRows[0].length, 9, '銷售群組寫入契約必須維持固定 9 欄');
assert.deepEqual(Array.from(writtenRows[0].slice(1, 8)), ['message-id', '測試人員', '測試店', '下班', null, 20, 4]);

assert.equal(logs.length, 0);
console.log('Sales shift verification passed.');
