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

const ordinary = context.calculateShiftSales(10, 20, 4);
assert.equal(ordinary.isValid, true);
assert.equal(ordinary.shiftSalesCount, 10);
assert.equal(ordinary.salesRatio, 40);

const allSamsung = context.calculateShiftSales(10, 14, 4);
assert.equal(allSamsung.isValid, true);
assert.equal(allSamsung.shiftSalesCount, 4);
assert.equal(allSamsung.salesRatio, 100);

const noSales = context.calculateShiftSales(10, 10, 0);
assert.equal(noSales.isValid, true);
assert.equal(noSales.shiftSalesCount, 0);
assert.equal(noSales.salesRatio, 0);

const backwards = context.calculateShiftSales(10, 9, 0);
assert.equal(backwards.isValid, false);
assert.match(backwards.message, /不能小於到點初始台數/);

const samsungOverDelta = context.calculateShiftSales(10, 20, 11);
assert.equal(samsungOverDelta.isValid, false);
assert.match(samsungOverDelta.message, /不能大於當班全品牌銷量/);

assert.equal(context.parseNumber('12'), 12);
assert.equal(context.parseNumber('12台'), 12);
assert.equal(context.parseNumber('0'), 0);
assert.equal(context.parseNumber('-1'), null);
assert.equal(context.parseNumber('1.5'), null);
assert.equal(context.parseNumber('12abc'), null);

const now = Date.now();
rows = [
  [new Date(now - 60_000), 'newer', '測試人員', '測試店', '到點', 12],
  [new Date(now - 3_600_000), 'earliest', '測試人員', '測試店', '到點', 10]
];
const startReport = context.getStartReport('測試人員', '測試店');
assert.equal(startReport.message, null);
assert.equal(startReport.startCount, 10);

const checkout = context.analyzeCheckOut(
  ['下班', '測試店', '20', '4'],
  { isValid: false, needResponse: false },
  '測試人員'
);
assert.equal(checkout.isValid, true);
assert.equal(checkout.shiftSalesCount, 10);
assert.equal(checkout.salesRatio, 40);

const backwardsCheckout = context.analyzeCheckOut(
  ['下班', '測試店', '9', '0'],
  { isValid: false, needResponse: false },
  '測試人員'
);
assert.equal(backwardsCheckout.isValid, false);
assert.match(backwardsCheckout.message, /不能小於到點初始台數/);

const zeroDeltaReply = context.generateResponse({
  type: '下班',
  shiftSalesCount: 0,
  samsungCount: 0,
  salesRatio: 0
}, '測試人員');
assert.match(zeroDeltaReply, /當班全店無銷售任何螢幕/);

rows = [[new Date(now - 3_600_000), 'invalid', '測試人員', '測試店', '到點', '']];
const invalidStart = context.getStartReport('測試人員', '測試店');
assert.equal(invalidStart.startCount, null);
assert.match(invalidStart.message, /初始台數無法辨識/);

rows = [];
const missingStart = context.getStartReport('測試人員', '測試店');
assert.equal(missingStart.startCount, null);
assert.match(missingStart.message, /請先報到/);

assert.match(source, /getRange\(1,\s*4,\s*lastRow,\s*2\)/, 'LINE 姓名仍須固定只讀 D:E');
assert.match(mainSource, /getRange\("G2:G"\s*\+\s*sheet\.getLastRow\(\)\)/, '店點白名單仍須固定讀 G');
assert.equal(context.recordSalesData(Date.now(), 'message-id', 'user-id', '測試人員', '測試店', '下班', null, 20, 4), true);
assert.equal(writtenRows.length, 1);
assert.equal(writtenRows[0].length, 9, '銷售群組寫入契約必須維持固定 9 欄');
assert.deepEqual(Array.from(writtenRows[0].slice(1, 8)), ['message-id', '測試人員', '測試店', '下班', null, 20, 4]);

assert.equal(logs.length, 0);
console.log('Sales shift verification passed.');
