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
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, SALES_DUTY_HEADERS.length).setValues([row]);
  sheet.getRange(2, 1).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  sheet.getRange(2, 9).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  return true;
}

function buildSalesDutyRow_(timestamp, messageId, displayName, store, type, startCount, endCount, samsungCount) {
  return [
    new Date(timestamp),
    messageId,
    displayName,
    store,
    type,
    startCount,
    endCount,
    samsungCount,
    new Date()
  ];
}

function syncSalesDutyHistoryToNew_() {
  const source = getLegacySalesDutySheet_();
  const target = getNewSalesDutySheet_();
  const sourceLastRow = source.getLastRow();
  if (sourceLastRow <= 1) return { sourceRows: 0, insertedRows: 0, missingAfter: 0 };

  const since = new Date(SALES_DUTY_SYNC_SINCE + 'T00:00:00+08:00');
  const sourceRows = source.getRange(2, 1, sourceLastRow - 1, SALES_DUTY_HEADERS.length).getValues()
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
    const displayName = getCustomDisplayName(userId);
    const parts = message.split('/').map(part => part.trim());
    
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
      salesRatio: null
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

    if (result.isValid && !getValidStoreNames().includes(result.store)) {
      result.isValid = false;
      result.message = '無效的店點名稱。Valid store names: ' + JSON.stringify(getValidStoreNames());
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
        result.samsungCount
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

  // 檢查重複報到
  const duplicateReport = checkDuplicateReport(displayName, { store: parts[1] });
  if (duplicateReport) {
    result.message = duplicateReport;
    result.needResponse = true;
    return result;
  }

  result.isValid = true;
  result.needResponse = true;
  result.type = '到點';
  result.store = parts[1];
  result.startCount = startCount;

  return result;
}

// 分析下班訊息
function analyzeCheckOut(parts, result, displayName) {
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

  // 既有 LINE 流程只要求同人同店當日有到點紀錄。
  // 到點初始台數與下班總台數不是可強制單調遞增的累計對，不得相減後阻擋下班。
  const startReportError = checkStartReport(displayName, parts[1]);
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
  result.store = parts[1];
  result.endCount = endCount;
  result.samsungCount = samsungCount;
  result.salesRatio = endCount === 0 ? 0 : (samsungCount / endCount) * 100;

  return result;
}

// 檢查重複報到
function checkDuplicateReport(displayName, result) {
  try {
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
          row[3] === result.store && 
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
function checkStartReport(displayName, store) {
  try {
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
          row[3] === store && 
          row[4] === '到點') {
        return null;
      }
    }

    return `${displayName} 今天尚未在 ${store} 報到，請先報到`;
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
    return `${displayName} 上班打卡成功`;
  }

  if (result.type === '下班') {
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const timeStr = `${now.getMonth() + 1}/${now.getDate()}(${weekdays[now.getDay()]}) ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

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
function recordSalesData(timestamp, messageId, userId, displayName, store, type, startCount = null, endCount = null, samsungCount = null) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const row = buildSalesDutyRow_(timestamp, messageId, displayName, store, type, startCount, endCount, samsungCount);
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
