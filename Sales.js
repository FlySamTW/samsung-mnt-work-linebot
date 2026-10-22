// ====================
// 銷售群組相關功能
// ====================

// 銷售勤務在並行期寫入既有 LINE 工作簿與新制銷售工作簿。
// 正式切換只調整 Script Property，不更換 LINE webhook 或群組輸入格式。
var SALES_DUTY_NEW_SPREADSHEET_ID = '1dNJxwn8HaY6dnGh7pogsoscg6Oo3nVfW8wxpLNGv2Q4';
var SALES_DUTY_NEW_SHEET_NAME = 'LINE勤務';
var SALES_DUTY_WRITE_MODE_PROPERTY = 'SALES_DUTY_WRITE_MODE';
var SALES_DUTY_WRITE_MODE_DUAL = 'DUAL';
var SALES_DUTY_WRITE_MODE_NEW_ONLY = 'NEW_ONLY';
var SALES_DUTY_SYNC_SINCE = '2026-08-01';
var SALES_DUTY_HEADERS = [
  '時間戳記', '訊息ID', '使用者名稱', '店點', '類型',
  '初始台數', '結束台數', '三星台數', '記錄時間'
];
// A:I 的既有契約不變；只有活動勤務使用 J:K 保存活動歸屬與當時名稱。
var SALES_DUTY_ACTIVITY_HEADERS = ['activity_id', 'activity_name_snapshot'];
var SALES_ACTIVITY_STORE_NAME = '活動支援';
var SALES_ACTIVITY_SETTINGS_SHEET_NAME = '活動支援設定';
var SALES_ACTIVITY_SETTINGS_HEADERS = [
  'activity_id', 'name', 'start_date', 'end_date',
  'latitude', 'longitude', 'radius_m', 'active'
];

function salesActivityIsEnabled_(value) {
  return value === true || value === 1 || /^(true|1|yes|y|on|是|啟用)$/i.test(String(value || '').trim());
}

function salesActivityDateKey_(value) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (match) {
      const key = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
      const parsed = new Date(key + 'T00:00:00Z');
      if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key) return '';
      return key;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (value === null || value === undefined || value === '' || isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd');
}

// 新活動流程才查正式銷售身分；不變更原店點的既有使用規則或 D:M 資料。
function getSalesActivityMember_(userId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('群組&姓名對應');
  if (!sheet || sheet.getLastRow() < 2 || !String(userId || '').trim()) return null;
  const matches = sheet.getRange(2, 4, sheet.getLastRow() - 1, 10).getValues()
    .filter(row => String(row[0] || '').trim() === String(userId).trim());
  if (matches.length !== 1) return null;
  const row = matches[0];
  const reporterId = String(row[4] || '').trim(); // H：銷售人員 ID
  const name = String(row[7] || row[1] || '').trim(); // K 正式姓名，備援 E
  if (!reporterId || !name || !salesActivityIsEnabled_(row[5])) return null; // I：啟用
  if (/^(test|temporary|temp)(?:$|[-_\s\d])/i.test(reporterId) || /^(test|temporary|測試(?:人員|帳號)?)$/i.test(name)) return null;
  return { reporter_id: reporterId, name: name };
}

function getSalesActivityOptions_(timestamp) {
  const day = salesActivityDateKey_(timestamp === undefined ? new Date() : timestamp);
  if (!day) throw new Error('活動日期無效');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_ACTIVITY_SETTINGS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const headers = sheet.getRange(1, 1, 1, SALES_ACTIVITY_SETTINGS_HEADERS.length).getValues()[0];
  if (!SALES_ACTIVITY_SETTINGS_HEADERS.every((header, index) => String(headers[index] || '').trim() === header)) {
    throw new Error('活動支援設定標題列不符');
  }
  const ids = new Set();
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, SALES_ACTIVITY_SETTINGS_HEADERS.length).getValues()
    .map(row => {
      if (!salesActivityIsEnabled_(row[7])) return null;
      const id = String(row[0] || '').trim();
      const name = String(row[1] || '').trim();
      const start = salesActivityDateKey_(row[2]);
      const end = salesActivityDateKey_(row[3]);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id) || !name || !start || !end || start > end || ids.has(id)) {
        throw new Error('活動支援設定有重複代碼或無效欄位');
      }
      ids.add(id);
      return start <= day && day <= end ? { activity_id: id, name: name } : null;
    }).filter(Boolean);
}

function salesActivitySelectionMessage_(parts, options) {
  const countStart = parts.length === (parts[0] === '到點' ? 4 : 5) ? 3 : 2;
  const counts = parts.slice(countStart);
  return '今天有多場活動，請複製對應活動的格式回報：\n' + options.map(activity =>
    activity.name + '\n' + [parts[0], SALES_ACTIVITY_STORE_NAME, activity.activity_id].concat(counts).join('/')
  ).join('\n\n') + '\n台數請填今日活動現場全體累計；個人成交另填銷售回報表。';
}

// 單一活動自動帶入；多場活動須明確選定，不能默認第一場或沿用別場勤務。
function resolveSalesActivityCommand_(parts, result) {
  const baseLength = parts[0] === '到點' ? 3 : 4;
  if (normalizeSalesStoreName_(parts[1]) !== SALES_ACTIVITY_STORE_NAME) return parts;
  if (parts.length !== baseLength && parts.length !== baseLength + 1) {
    result.message = parts[0] === '到點'
      ? '格式錯誤，正確格式為：到點/活動支援/初始台數；多場時用：到點/活動支援/活動ID/初始台數'
      : '格式錯誤，正確格式為：下班/活動支援/總台數/三星台數；多場時用：下班/活動支援/活動ID/總台數/三星台數';
    result.needResponse = true;
    return null;
  }
  let options;
  try {
    options = getSalesActivityOptions_(result.timestamp);
  } catch (error) {
    writeLog('Sales activity settings unavailable | ' + error.toString());
    result.message = '目前無法確認活動設定，請稍後再試或請主管確認。';
    result.needResponse = true;
    return null;
  }
  if (!options.length) {
    result.message = '目前沒有可填報的活動支援，請確認活動日期或請主管新增活動設定。';
    result.needResponse = true;
    return null;
  }
  const selector = parts.length === baseLength + 1 ? parts[2] : '';
  const matches = selector ? options.filter(activity => activity.activity_id === selector || activity.name === selector) : options;
  if (matches.length !== 1) {
    result.message = (selector ? '所選活動不在今日可用名單，或名稱重複，請使用活動ID。\n' : '') +
      salesActivitySelectionMessage_(parts, options);
    result.needResponse = true;
    return null;
  }
  result.activity = matches[0];
  return selector ? [parts[0], parts[1]].concat(parts.slice(3)) : parts;
}

// 新竹／竹北店歷史上曾使用多種名稱；正式顯示與新寫入一律統一為「順發竹北」。
// 只在銷售勤務內正規化，不影響商化店點或其他群組。
function normalizeSalesStoreName_(store) {
  const original = String(store || '').trim();
  const compact = original.replace(/\s+/g, '');
  const aliases = {
    'SALES_ACTIVITY_SUPPORT': SALES_ACTIVITY_STORE_NAME,
    '活動支援': SALES_ACTIVITY_STORE_NAME,
    '新竹順發': '順發竹北',
    '竹北順發': '順發竹北',
    '順發竹北店': '順發竹北',
    '順發新竹': '順發竹北',
    '新竹竹北': '順發竹北',
    '順發竹北': '順發竹北'
  };
  return aliases[compact] || original;
}

function getCanonicalValidSalesStoreNames_() {
  return Array.from(new Set(getValidStoreNames().map(normalizeSalesStoreName_).filter(Boolean).concat([SALES_ACTIVITY_STORE_NAME])));
}

function getSalesDutyWriteMode_() {
  try {
    const value = PropertiesService.getScriptProperties().getProperty(SALES_DUTY_WRITE_MODE_PROPERTY);
    return value === SALES_DUTY_WRITE_MODE_NEW_ONLY
      ? SALES_DUTY_WRITE_MODE_NEW_ONLY
      : SALES_DUTY_WRITE_MODE_DUAL;
  } catch (error) {
    writeLog('Error in getSalesDutyWriteMode_: ' + error.toString());
    return SALES_DUTY_WRITE_MODE_DUAL;
  }
}

function getLegacySalesDutySheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) throw new Error('找不到既有銷售勤務分頁：' + SALES_SHEET_NAME);
  return sheet;
}

function ensureSalesDutySheetContract_(sheet) {
  if (!sheet) throw new Error('新制 LINE勤務 分頁不存在');

  const currentHeader = sheet.getRange(1, 1, 1, SALES_DUTY_HEADERS.length).getValues()[0];
  const headerIsEmpty = currentHeader.every(value => String(value || '').trim() === '');
  if (headerIsEmpty) {
    sheet.getRange(1, 1, 1, SALES_DUTY_HEADERS.length).setValues([SALES_DUTY_HEADERS]);
  } else {
    const headerMatches = SALES_DUTY_HEADERS.every((header, index) => String(currentHeader[index] || '') === header);
    if (!headerMatches) throw new Error('新制 LINE勤務 標題列不符合固定 A:I 契約');
  }

  sheet.getRange(1, 1, 1, SALES_DUTY_HEADERS.length)
    .setBackground('#ffffff')
    .setFontColor('#000000')
    .setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

function getNewSalesDutySheet_() {
  const workbook = SpreadsheetApp.openById(SALES_DUTY_NEW_SPREADSHEET_ID);
  let sheet = workbook.getSheetByName(SALES_DUTY_NEW_SHEET_NAME);
  if (!sheet) sheet = workbook.insertSheet(SALES_DUTY_NEW_SHEET_NAME);
  return ensureSalesDutySheetContract_(sheet);
}

function getSalesDutyReadWidth_(sheet) {
  const required = SALES_DUTY_HEADERS.length + SALES_DUTY_ACTIVITY_HEADERS.length;
  if (sheet.getMaxColumns() < required) return SALES_DUTY_HEADERS.length;
  const header = sheet.getRange(1, SALES_DUTY_HEADERS.length + 1, 1, SALES_DUTY_ACTIVITY_HEADERS.length).getValues()[0];
  if (SALES_DUTY_ACTIVITY_HEADERS.every((name, index) => String(header[index] || '').trim() === name)) return required;
  return SALES_DUTY_HEADERS.length;
}

function ensureSalesDutyActivityColumns_(sheet) {
  const required = SALES_DUTY_HEADERS.length + SALES_DUTY_ACTIVITY_HEADERS.length;
  const maxColumns = sheet.getMaxColumns();
  if (maxColumns < required) sheet.insertColumnsAfter(maxColumns, required - maxColumns);
  const range = sheet.getRange(1, SALES_DUTY_HEADERS.length + 1, 1, SALES_DUTY_ACTIVITY_HEADERS.length);
  const header = range.getValues()[0];
  if (!header.every((value, index) => !String(value || '').trim() || String(value).trim() === SALES_DUTY_ACTIVITY_HEADERS[index])) {
    throw new Error('勤務 J:K 已有其他欄位，拒絕覆寫');
  }
  if (!SALES_DUTY_ACTIVITY_HEADERS.every((name, index) => String(header[index] || '').trim() === name)) {
    // 只有欄位名稱空白且下方無資料才可以補標題，避免覆蓋既有未知資料。
    if (sheet.getLastRow() > 1 && sheet.getRange(2, SALES_DUTY_HEADERS.length + 1, sheet.getLastRow() - 1, SALES_DUTY_ACTIVITY_HEADERS.length)
      .getValues().some(row => row.some((value, index) => !String(header[index] || '').trim() && String(value || '').trim()))) {
      throw new Error('勤務 J:K 有未識別資料，拒絕覆寫');
    }
    range.setValues([SALES_DUTY_ACTIVITY_HEADERS]);
    range.setBackground('#ffffff').setFontColor('#000000').setFontWeight('bold');
  }
}

function getSalesDutyReadSheet_() {
  return getSalesDutyWriteMode_() === SALES_DUTY_WRITE_MODE_NEW_ONLY
    ? getNewSalesDutySheet_()
    : getLegacySalesDutySheet_();
}

function salesDutyMessageExists_(sheet, messageId) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;
  const target = String(messageId || '');
  return sheet.getRange(2, 2, lastRow - 1, 1).getValues()
    .some(row => String(row[0] || '') === target);
}

function writeSalesDutyRow_(sheet, row) {
  if (salesDutyMessageExists_(sheet, row[1])) return false;
  const activityRow = normalizeSalesStoreName_(row[3]) === SALES_ACTIVITY_STORE_NAME;
  if (activityRow) {
    if (!String(row[9] || '').trim() || !String(row[10] || '').trim()) throw new Error('活動勤務缺少活動ID或名稱');
    ensureSalesDutyActivityColumns_(sheet);
  }
  const values = row.slice(0, activityRow ? 11 : SALES_DUTY_HEADERS.length);
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, values.length).setValues([values]);
  sheet.getRange(2, 1).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  sheet.getRange(2, 9).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  return true;
}

function buildSalesDutyRow_(timestamp, messageId, displayName, store, type, startCount, endCount, samsungCount, activity) {
  const row = [
    new Date(timestamp),
    messageId,
    displayName,
    normalizeSalesStoreName_(store),
    type,
    startCount,
    endCount,
    samsungCount,
    new Date()
  ];
  if (row[3] === SALES_ACTIVITY_STORE_NAME) {
    if (!activity || !String(activity.activity_id || '').trim() || !String(activity.name || '').trim()) {
      throw new Error('活動勤務必須指定活動ID與名稱');
    }
    row.push(String(activity.activity_id).trim(), String(activity.name).trim());
  }
  return row;
}

function syncSalesDutyHistoryToNew_() {
  const source = getLegacySalesDutySheet_();
  const target = getNewSalesDutySheet_();
  const sourceLastRow = source.getLastRow();
  if (sourceLastRow <= 1) return { sourceRows: 0, insertedRows: 0, missingAfter: 0 };

  const since = new Date(SALES_DUTY_SYNC_SINCE + 'T00:00:00+08:00');
  const sourceRows = source.getRange(2, 1, sourceLastRow - 1, getSalesDutyReadWidth_(source)).getValues()
    .filter(row => row[0] instanceof Date && !isNaN(row[0].getTime()) && row[0].getTime() >= since.getTime());
  let insertedRows = 0;
  sourceRows.slice().reverse().forEach(row => {
    if (writeSalesDutyRow_(target, row)) insertedRows += 1;
  });

  SpreadsheetApp.flush();
  const missingAfter = sourceRows.filter(row => !salesDutyMessageExists_(target, row[1])).length;
  return { sourceRows: sourceRows.length, insertedRows, missingAfter };
}

// 管理者可手動執行；正式切換前也會強制先補齊並讀回確認。
function syncSalesDutyHistoryToNew() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return syncSalesDutyHistoryToNew_();
  } finally {
    lock.releaseLock();
  }
}

// mode 僅接受 DUAL 或 NEW_ONLY。切到 NEW_ONLY 前不得存在未補齊列。
function setSalesDutyWriteMode(mode) {
  const normalized = String(mode || '').trim().toUpperCase();
  if (![SALES_DUTY_WRITE_MODE_DUAL, SALES_DUTY_WRITE_MODE_NEW_ONLY].includes(normalized)) {
    throw new Error('SALES_DUTY_WRITE_MODE 僅接受 DUAL 或 NEW_ONLY');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureSalesDutySheetContract_(getNewSalesDutySheet_());
    if (normalized === SALES_DUTY_WRITE_MODE_NEW_ONLY) {
      const syncResult = syncSalesDutyHistoryToNew_();
      if (syncResult.missingAfter !== 0) throw new Error('新制 LINE勤務 尚有未補齊資料，拒絕切換');
    }
    PropertiesService.getScriptProperties().setProperty(SALES_DUTY_WRITE_MODE_PROPERTY, normalized);
    return normalized;
  } finally {
    lock.releaseLock();
  }
}

// Apps Script 編輯器的管理入口（編輯器無法替函式帶入參數）。
function enableSalesDutyDualWrite() {
  return setSalesDutyWriteMode(SALES_DUTY_WRITE_MODE_DUAL);
}

// 只有管理者明確下令切換後才可執行；內部仍會先跑完整同步守門。
function enableSalesDutyNewOnly() {
  return setSalesDutyWriteMode(SALES_DUTY_WRITE_MODE_NEW_ONLY);
}

function countSalesDutyMessage_(sheet, messageId) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;
  const target = String(messageId || '');
  return sheet.getRange(2, 2, lastRow - 1, 1).getValues()
    .filter(row => String(row[0] || '') === target).length;
}

function deleteSalesDutyMessage_(sheet, messageId) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;
  const target = String(messageId || '');
  const ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  let deleted = 0;
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    if (String(ids[index][0] || '') !== target) continue;
    sheet.deleteRow(index + 2);
    deleted += 1;
  }
  return deleted;
}

// 管理者煙霧測試：以唯一訊息 ID 寫入兩表、讀回確認，再精準刪除並再次讀回。
// 不經 LINE、不發群組訊息，也不使用真實人員姓名。
function smokeTestSalesDutyDualWrite() {
  if (getSalesDutyWriteMode_() !== SALES_DUTY_WRITE_MODE_DUAL) {
    throw new Error('目前不是 DUAL，拒絕執行雙寫煙霧測試');
  }

  const messageId = 'codex-duty-smoke-' + Utilities.getUuid();
  const legacy = getLegacySalesDutySheet_();
  const current = getNewSalesDutySheet_();
  try {
    const saved = recordSalesData(
      Date.now(), messageId, 'codex-test', 'Codex dual-write smoke',
      '內湖燦坤', '到點', 0, null, null
    );
    if (!saved) throw new Error('雙寫煙霧測試寫入失敗');
    SpreadsheetApp.flush();

    const legacyCount = countSalesDutyMessage_(legacy, messageId);
    const currentCount = countSalesDutyMessage_(current, messageId);
    if (legacyCount !== 1 || currentCount !== 1) {
      throw new Error('雙寫讀回不一致：legacy=' + legacyCount + ', new=' + currentCount);
    }
  } finally {
    deleteSalesDutyMessage_(legacy, messageId);
    deleteSalesDutyMessage_(current, messageId);
    SpreadsheetApp.flush();
    const legacyRemaining = countSalesDutyMessage_(legacy, messageId);
    const currentRemaining = countSalesDutyMessage_(current, messageId);
    if (legacyRemaining !== 0 || currentRemaining !== 0) {
      throw new Error('煙霧測試清理失敗：legacy=' + legacyRemaining + ', new=' + currentRemaining);
    }
  }

  return { messageId, legacyWritten: 1, newWritten: 1, cleaned: true };
}

// 取得自訂顯示名稱
function getCustomDisplayName(userId) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('群組&姓名對應');
    const lastRow = sheet.getLastRow();
    const data = sheet.getRange(1, 4, lastRow, 2).getValues(); // D和E欄的資料
    
    for (let row of data) {
      if (row[0] === userId) {  // 如果找到對應的 ID
        return row[1];          // 返回對應的名稱
      }
    }
    
    // 如果在表中找不到，才使用 LINE API 取得名稱
    return getDisplayName(userId);
  } catch (error) {
    writeLog("Error in getCustomDisplayName: " + error.toString());
    return getDisplayName(userId); // 發生錯誤時使用原本的方式
  }
}

// 處理銷售群組訊息
function processSalesGroupMessage(timestamp, messageId, userId, message) {
  try {
    const parts = message.split('/').map(part => part.trim());
    const isActivity = ['到點', '下班'].includes(parts[0]) && normalizeSalesStoreName_(parts[1]) === SALES_ACTIVITY_STORE_NAME;
    let displayName;
    if (isActivity) {
      let member;
      try {
        member = getSalesActivityMember_(userId);
      } catch (error) {
        writeLog('Sales activity member lookup unavailable | ' + error.toString());
        return '目前無法確認銷售人員資格，請稍後再試。';
      }
      if (!member) return '活動支援限已啟用且綁定 LINE 的正式銷售人員，請主管確認人員設定。';
      displayName = member.name;
    } else {
      displayName = getCustomDisplayName(userId);
    }
    
    let result = {
      isValid: false,
      needResponse: false,
      message: null,
      type: null,
      status: null,
      store: null,
      startCount: null,
      endCount: null,
      samsungCount: null,
      salesRatio: null,
      timestamp: timestamp,
      activity: null
    };

    if (parts.length < 2) {
      writeLog("非指令碼，一般紀錄寫入");
      return null;
    }

    switch (parts[0]) {
      case '到點':
        result = analyzePunchIn(parts, result, displayName);
        break;
      case '下班':
        result = analyzeCheckOut(parts, result, displayName);
        break;
      default:
        writeLog("未知的訊息類型");
        return null;
    }

    const validStoreNames = getCanonicalValidSalesStoreNames_();
    if (result.isValid && !validStoreNames.includes(result.store)) {
      result.isValid = false;
      result.message = '無效的店點名稱。Valid store names: ' + JSON.stringify(validStoreNames);
      result.needResponse = true;
    }

    if (result.isValid) {
      const recorded = recordSalesData(
        timestamp,
        messageId,
        userId,
        displayName,
        result.store,
        result.type,
        result.startCount,
        result.endCount,
        result.samsungCount,
        result.activity
      );
      if (!recorded) {
        result.isValid = false;
        result.message = '系統暫時無法完成打卡，請稍後再試';
        result.needResponse = true;
      }
    }

    return result.needResponse ? generateResponse(result, displayName) : null;

  } catch (error) {
    writeLog("Error in processSalesGroupMessage: " + error.toString());
    return null;
  }
}

// 分析到點訊息
function analyzePunchIn(parts, result, displayName) {
  parts = resolveSalesActivityCommand_(parts, result);
  if (!parts) return result;
  if (parts.length !== 3) {
    result.message = '格式錯誤，正確格式為：到點/店點/初始台數';
    result.needResponse = true;
    return result;
  }

  const startCount = parseNumber(parts[2]);
  if (startCount === null) {
    result.message = '台數格式錯誤，請使用正確的數字格式';
    result.needResponse = true;
    return result;
  }

  const store = normalizeSalesStoreName_(parts[1]);

  // 檢查重複報到
  const duplicateReport = checkDuplicateReport(displayName, { store: store, activity: result.activity, timestamp: result.timestamp });
  if (duplicateReport) {
    result.message = duplicateReport;
    result.needResponse = true;
    return result;
  }

  result.isValid = true;
  result.needResponse = true;
  result.type = '到點';
  result.store = store;
  result.startCount = startCount;

  return result;
}

// 分析下班訊息
function analyzeCheckOut(parts, result, displayName) {
  parts = resolveSalesActivityCommand_(parts, result);
  if (!parts) return result;
  if (parts.length !== 4) {
    result.message = '格式錯誤，正確格式為：下班/店點/總台數/三星台數';
    result.needResponse = true;
    return result;
  }

  const endCount = parseNumber(parts[2]);
  const samsungCount = parseNumber(parts[3]);
  
  if (endCount === null || samsungCount === null) {
    result.message = '台數格式錯誤，請使用正確的數字格式';
    result.needResponse = true;
    return result;
  }

  const store = normalizeSalesStoreName_(parts[1]);

  // 既有 LINE 流程只要求同人同店當日有到點紀錄。
  // 到點初始台數與下班總台數不是可強制單調遞增的累計對，不得相減後阻擋下班。
  const startReportError = checkStartReport(displayName, store, result.activity, result.timestamp);
  if (startReportError) {
    result.message = startReportError;
    result.needResponse = true;
    return result;
  }

  if (samsungCount > endCount) {
    result.message = '三星台數不能大於下班總台數';
    result.needResponse = true;
    return result;
  }

  result.isValid = true;
  result.needResponse = true;
  result.type = '下班';
  result.store = store;
  result.endCount = endCount;
  result.samsungCount = samsungCount;
  result.salesRatio = endCount === 0 ? 0 : (samsungCount / endCount) * 100;

  return result;
}

function hasSalesActivityArrival_(displayName, activity, timestamp) {
  if (!activity || !activity.activity_id) throw new Error('活動勤務缺少活動ID');
  const day = salesActivityDateKey_(timestamp === undefined ? new Date() : timestamp);
  if (!day) throw new Error('活動勤務日期無效');
  const sheet = getSalesDutyReadSheet_();
  if (sheet.getLastRow() <= 1 || getSalesDutyReadWidth_(sheet) < 11) return false;
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues().some(row =>
    salesActivityDateKey_(row[0]) === day &&
    row[2] === displayName &&
    normalizeSalesStoreName_(row[3]) === SALES_ACTIVITY_STORE_NAME &&
    row[4] === '到點' && String(row[9] || '').trim() === activity.activity_id
  );
}

// 檢查重複報到；活動須同日、同人、同活動ID，不能只比較共用店名。
function checkDuplicateReport(displayName, result) {
  try {
    if (normalizeSalesStoreName_(result.store) === SALES_ACTIVITY_STORE_NAME) {
      return hasSalesActivityArrival_(displayName, result.activity, result.timestamp)
        ? `${displayName} 今天已經在 ${result.activity.name} 報到過了` : null;
    }
    const sheet = getSalesDutyReadSheet_();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    today.setMilliseconds(0);
    
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return null;
    
    const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    
    for (let row of data) {
      const recordDate = new Date(row[0]);
      recordDate.setHours(0, 0, 0, 0);
      recordDate.setMilliseconds(0);
      
      if (recordDate.getTime() === today.getTime() && 
          row[2] === displayName && 
          normalizeSalesStoreName_(row[3]) === normalizeSalesStoreName_(result.store) &&
          row[4] === '到點') {
        return `${displayName} 今天已經在 ${result.store} 報到過了`;
      }
    }
    
    return null;
  } catch (error) {
    writeLog("Error in checkDuplicateReport: " + error.toString());
    return '目前無法確認今日到點紀錄，請稍後再試';
  }
}

// 檢查同一人員、同一店點今日是否已有到點紀錄。
function checkStartReport(displayName, store, activity, timestamp) {
  try {
    const canonicalStore = normalizeSalesStoreName_(store);
    if (canonicalStore === SALES_ACTIVITY_STORE_NAME) {
      return hasSalesActivityArrival_(displayName, activity, timestamp)
        ? null : `${displayName} 今天尚未在 ${activity.name} 報到，請先報到`;
    }
    const sheet = getSalesDutyReadSheet_();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    today.setMilliseconds(0);
    
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return `${displayName} 今天尚未在 ${store} 報到，請先報到`;
    }

    const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    
    for (let row of data) {
      const recordDate = new Date(row[0]);
      recordDate.setHours(0, 0, 0, 0);
      recordDate.setMilliseconds(0);
      
      if (recordDate.getTime() === today.getTime() && 
          row[2] === displayName && 
          normalizeSalesStoreName_(row[3]) === canonicalStore &&
          row[4] === '到點') {
        return null;
      }
    }

    return `${displayName} 今天尚未在 ${canonicalStore} 報到，請先報到`;
  } catch (error) {
    writeLog("Error in checkStartReport: " + error.toString());
    return '目前無法讀取到點紀錄，請稍後再試';
  }
}

// 生成回應訊息
function generateResponse(result, displayName) {
  if (!result || !displayName) return null;
  if (result.message) return result.message;

  if (result.type === '到點') {
    if (result.activity) {
      return `${displayName} 上班打卡成功\n活動支援｜${result.activity.name}\n台數填今日活動現場全體累計；個人成交請填銷售回報表。`;
    }
    return `${displayName} 上班打卡成功`;
  }

  if (result.type === '下班') {
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const timeStr = `${now.getMonth() + 1}/${now.getDate()}(${weekdays[now.getDay()]}) ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (result.activity) {
      return `${timeStr}\n${displayName} 下班打卡成功\n活動支援｜${result.activity.name}\n今日活動現場累計：總台數 ${result.endCount}、三星 ${result.samsungCount}\n活動銷售佔比 ${result.salesRatio.toFixed(1)}%\n同場人員填截至當時的全場累計；個人成交請填銷售回報表。`;
    }

    if (result.endCount === 0) {
      return `${timeStr}\n${displayName} 下班打卡成功\n當班全店無銷售任何螢幕`;
    }
    if (result.samsungCount === 0) {
      return `${timeStr}\n${displayName} 下班打卡成功\n當班無銷售三星螢幕`;
    }
    return `${timeStr}\n${displayName} 下班打卡成功\n今日銷售佔比為 ${result.salesRatio.toFixed(1)}%`;
  }

  return null;
}

// 記錄銷售資料
function recordSalesData(timestamp, messageId, userId, displayName, store, type, startCount = null, endCount = null, samsungCount = null, activity = null) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const row = buildSalesDutyRow_(timestamp, messageId, displayName, store, type, startCount, endCount, samsungCount, activity);
    const mode = getSalesDutyWriteMode_();

    if (mode === SALES_DUTY_WRITE_MODE_NEW_ONLY) {
      writeSalesDutyRow_(getNewSalesDutySheet_(), row);
    } else {
      // 並行期間先完成既有正式表；新表失敗只記錄，不能使正在營運的舊流程中斷。
      writeSalesDutyRow_(getLegacySalesDutySheet_(), row);
      try {
        writeSalesDutyRow_(getNewSalesDutySheet_(), row);
      } catch (newSheetError) {
        writeLog('Sales dual-write pending | messageId=' + messageId + ' | ' + newSheetError.toString());
      }
    }

    SpreadsheetApp.flush();
    return true;
  } catch (error) {
    writeLog("Error in recordSalesData: " + error.toString());
    return false;
  } finally {
    try {
      lock.releaseLock();
    } catch (ignore) {}
  }
}

// 解析數字
function parseNumber(str) {
  try {
    const normalized = String(str).trim().replace(/台$/, '').trim();
    if (!/^(0|[1-9]\d*)$/.test(normalized)) return null;
    const num = Number(normalized);
    return Number.isSafeInteger(num) ? num : null;
  } catch (error) {
    return null;
  }
}
