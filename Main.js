// ====================
// 版本更新號：v6.0.0 (2026-01-19)
// ====================
var REMINDER_SHEET_NAME = '商化提醒';
var SALES_SHEET_NAME    = '銷售群組';
var ALL_SHEET_NAME = 'ALL';
var LOG_SHEET_NAME = 'LOG';
var SALES_GROUP_ID = "Ceef408d9179d98e7cc0bcb028a16d86b";

// 動態讀取店點白名單
function getValidStoreNames() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('群組&姓名對應');
    var range = sheet.getRange("G2:G" + sheet.getLastRow());
    var values = range.getValues();
    var storeNames = [];
    
    writeLog("Reading range G2:G" + sheet.getLastRow() + " | ");
    for (var i = 0; i < values.length; i++) {
      var cellValue = values[i][0];
      writeLog("Row " + (i + 2) + ": Raw Value = " + JSON.stringify(cellValue) + " (Type: " + (typeof cellValue) + ") | ");
      if (cellValue !== null && cellValue !== undefined) {
        if (typeof cellValue === "string") {
          var trimmedValue = cellValue.trim();
          if (trimmedValue) {
            storeNames.push(trimmedValue);
            writeLog("Row " + (i + 2) + ": Added '" + trimmedValue + "' (Length: " + trimmedValue.length + ") | ");
          }
        } else if (typeof cellValue === "number") {
          var strValue = cellValue.toString().trim();
          if (strValue) {
            storeNames.push(strValue);
            writeLog("Row " + (i + 2) + ": Added (number) '" + strValue + "' (Length: " + strValue.length + ") | ");
          }
        }
      }
    }
    
    writeLog("Final storeNames array: " + JSON.stringify(storeNames));
    return storeNames;
  } catch (error) {
    writeLog("Error in getValidStoreNames: " + error.toString());
    return [];
  }
}

// ====================
// LINE API 相關功能
// ====================

// Token 管理
function getToken() {
  return PropertiesService.getScriptProperties().getProperty('TOKEN');
}

// 取得使用者名稱
function getDisplayName(userId) {
  try {
    writeLog("開始取得使用者名稱，userId: " + userId + " | ");

    var url = 'https://api.line.me/v2/bot/profile/' + userId;
    var options = {
      'headers': {
        'Authorization': 'Bearer ' + getToken()
      },
      'method': 'get',
      'muteHttpExceptions': true
    };

    var response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() === 200) {
      var userData = JSON.parse(response.getContentText());
      return userData.displayName;
    }
    return "未知使用者";
  } catch (error) {
    writeLog("取得使用者名稱時發生錯誤：" + error.toString() + " | ");
    return "未知使用者";
  }
}

// 發送訊息
function sendMessage(replyToken, message) {
  try {
    var url = 'https://api.line.me/v2/bot/message/reply';
    var postData = {
      'replyToken': replyToken,
      'messages': [{
        'type': 'text',
        'text': message
      }]
    };
    
    var options = {
      'headers': {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken()
      },
      'method': 'post',
      'payload': JSON.stringify(postData)
    };
    
    UrlFetchApp.fetch(url, options);
    return true;
  } catch (error) {
    writeLog("Error in sendMessage: " + error.toString() + " | ");
    return false;
  }
}

// ====================
// Webhook 處理
// ====================

function doPost(e) {
  try {
    const events = JSON.parse(e.postData.contents).events;
    
    if (events && events.length > 0) {
      const event = events[0];
      if (event.type === 'message' && 
          event.message.type === 'text' && 
          !event.deliveryContext?.isRedelivery) {
        
        // 加入重複訊息檢查
        if (isMessageIdExists(event.message.id, ALL_SHEET_NAME)) {
          writeLog("重複訊息，跳過處理 | ");
          return HtmlService.createHtmlOutput('OK');
        }

        writeLog("收到訊息: " + JSON.stringify(event) + " | ");
        processMessage(event);
      }
    }

    return HtmlService.createHtmlOutput('OK');

  } catch (error) {
    writeLog("Error in doPost: " + error.toString() + " | ");
    return HtmlService.createHtmlOutput('Error: ' + error.toString());
  }
}

// 處理訊息
function processMessage(event) {
  var logMessage = "";
  try {
    if (!event || !event.message || !event.message.text) {
      logMessage += "無效的事件格式 | ";
      writeLog(logMessage);
      return;
    }

    const { message, replyToken, source } = event;
    const userMessage = message.text.trim();
    if (!userMessage) {
      logMessage += "空白訊息，跳過處理 | ";
      writeLog(logMessage);
      return;
    }

    const userId = source.userId;
    const timestamp = event.timestamp;
    const sourceType = source.type;
    const groupId = sourceType === "group" ? source.groupId : "";
    const displayName = getDisplayName(userId);
    
    let botResponse = null;
    
    // 處理指令
    if (userMessage.startsWith("/")) {
      // 無論群組類型，優先處理以 / 開頭的指令
      logMessage += "處理指令開始 | ";
      botResponse = handleCommand(replyToken, userMessage, timestamp, message.id, userId, groupId, message.type);
      logMessage += "指令處理結果: " + (botResponse || "無回應") + " | ";
    } else if (groupId === SALES_GROUP_ID) {
      // 處理銷售群組訊息
      logMessage += "銷售群組訊息處理開始 | 群組ID: " + groupId + " | 使用者訊息: " + userMessage + " | ";
      botResponse = processSalesGroupMessage(timestamp, message.id, userId, userMessage);
      logMessage += "處理結果: " + (botResponse || "無回應") + " | ";
    }

    // 記錄訊息到 ALL sheet
    logAllMessages(
      new Date(timestamp),
      message.id,
      userId,
      displayName,
      groupId,
      message.type,
      userMessage,
      botResponse
    );
    
    // 發送回覆
    if (botResponse) {
      logMessage += "準備發送回應: " + botResponse + " | ";
      sendMessage(replyToken, botResponse);
    }

    writeLog(logMessage);

  } catch (error) {
    logMessage += "Error in processMessage: " + error.toString() + " | ";
    writeLog(logMessage);
  }
}

// ====================
// 工具函數
// ====================

// 檢查訊息是否存在
function isMessageIdExists(messageId, sheetName) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return false;
    
    var messageIds = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    return messageIds.some(row => row[0] === messageId);
  } catch (error) {
    writeLog("Error in isMessageIdExists: " + error.toString() + " | ");
    return false;
  }
}

// 記錄所有訊息
function logAllMessages(timestamp, messageId, userId, displayName, groupId, messageType, content, botResponse) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ALL_SHEET_NAME);
    
    sheet.insertRowBefore(2);
    var newRowData = [
      [
        timestamp,
        messageId,
        userId,
        displayName,
        groupId,
        messageType,
        content,
        botResponse,
        new Date()
      ]
    ];
    
    var range = sheet.getRange(2, 1, 1, newRowData[0].length);
    range.setValues(newRowData);
    
    sheet.getRange(2, 1).setNumberFormat("yyyy/MM/dd HH:mm:ss");
    sheet.getRange(2, 9).setNumberFormat("yyyy/MM/dd HH:mm:ss");

    SpreadsheetApp.flush();
    writeLog(`成功記錄訊息 ${messageId} | `);
    return true;

  } catch (error) {
    writeLog(`Error in logAllMessages: ${error.toString()} | `);
    return false;
  }
}

// 寫入日誌
function writeLog(message) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
    sheet.insertRowBefore(2);
    sheet.getRange(2, 1, 1, 2).setValues([[new Date(), message.trim()]]); // 去除末尾多餘的 |
    sheet.getRange(2, 1).setNumberFormat("yyyy/MM/dd HH:mm:ss");
    SpreadsheetApp.flush();

    // 檢查記錄數量
    var lastRow = sheet.getLastRow();
    if (lastRow > 1000) {
      // 計算需要刪除的行數
      var rowsToDelete = lastRow - 1000;
      
      // 刪除最舊的記錄
      sheet.deleteRows(1001, rowsToDelete); // 假設第一行是標題
    }
  } catch (error) {
    console.log("Error in writeLog: " + error.toString());
  }
}

// ====================
// 初始化和設定相關
// ====================

// 初始化工作表
function initializeSheets() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const requiredSheets = [REMINDER_SHEET_NAME, SALES_SHEET_NAME, ALL_SHEET_NAME, LOG_SHEET_NAME];
    const existingSheets = ss.getSheets().map(sheet => sheet.getName());
    
    requiredSheets.forEach(sheetName => {
      if (!existingSheets.includes(sheetName)) {
        ss.insertSheet(sheetName);
        writeLog(`已建立工作表：${sheetName} | `);
      }
    });

    return true;
  } catch (error) {
    writeLog("Error in initializeSheets: " + error.toString() + " | ");
    return false;
  }
}

// 設定每日清理觸發器
function createDailyCleanupTrigger() {
  try {
    // 刪除現有的清理觸發器
    var triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(function(trigger) {
      if (trigger.getHandlerFunction() === 'cleanupOldRecords') {
        ScriptApp.deleteTrigger(trigger);
      }
    });

    // 建立新的每日觸發器
    ScriptApp.newTrigger('cleanupOldRecords')
      .timeBased()
      .everyDays(1)
      .atHour(3)
      .create();

    writeLog("成功建立每日清理觸發器 | ");
  } catch (error) {
    writeLog("Error in createDailyCleanupTrigger: " + error.toString() + " | ");
  }
}

// 清理過期記錄
function cleanupOldRecords() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ALL_SHEET_NAME);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return;

    var now = new Date();
    var thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    var timestamps = sheet.getRange(2, 1, lastRow - 1).getValues();
    var rowsToDelete = [];

    for (var i = timestamps.length - 1; i >= 0; i--) {
      var timestamp = new Date(timestamps[i][0]);
      if (timestamp < thirtyDaysAgo) {
        rowsToDelete.push(i + 2);
      }
    }

    // 批次處理刪除
    const BATCH_SIZE = 100;
    for (let i = 0; i < rowsToDelete.length; i += BATCH_SIZE) {
      const batch = rowsToDelete.slice(i, i + BATCH_SIZE);
      batch.forEach(row => sheet.deleteRow(row));
      SpreadsheetApp.flush();
    }

    writeLog(`清理完成，共刪除 ${rowsToDelete.length} 筆記錄 | `);
  } catch (error) {
    writeLog("Error in cleanupOldRecords: " + error.toString() + " | ");
  }
}