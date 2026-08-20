// ====================
// 銷售群組相關功能
// ====================

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
      recordSalesData(
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
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
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
    return null;
  }
}

// 檢查同一人員、同一店點今日是否已有到點紀錄。
function checkStartReport(displayName, store) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
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
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
    
    sheet.insertRowBefore(2);
    const newRowData = [
      [
        new Date(timestamp),
        messageId,
        displayName,
        store,
        type,
        startCount,
        endCount,
        samsungCount,
        new Date()
      ]
    ];
    
    const range = sheet.getRange(2, 1, 1, newRowData[0].length);
    range.setValues(newRowData);
    
    sheet.getRange(2, 1).setNumberFormat("yyyy/MM/dd HH:mm:ss");
    sheet.getRange(2, 9).setNumberFormat("yyyy/MM/dd HH:mm:ss");
    
    SpreadsheetApp.flush();
    return true;
  } catch (error) {
    writeLog("Error in recordSalesData: " + error.toString());
    return false;
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
