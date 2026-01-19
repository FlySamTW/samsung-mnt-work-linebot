// 處理指令相關邏輯
function handleCommand(replyToken, userMessage, timestamp, messageId, userId, groupId, messageType) {
  try {
    var response = null;
    var displayName = getDisplayName(userId);
    writeLog("處理指令：" + userMessage);

    switch (true) {
      case userMessage === "?" || userMessage === "？" || userMessage === "/":
        response = getHelpMessage();
        break;

      case userMessage.startsWith("/查詢"):
        writeLog("執行查詢未處理訊息");
        clearTemporaryNumbers();
        response = queryUnprocessedMessages();
        break;

      case userMessage.startsWith("/紀錄") || userMessage.startsWith("/記錄"):
        writeLog("執行紀錄訊息");
        const messageContent = userMessage.replace(/^\/(紀錄|記錄)/, "").trim();
        const result = saveMessage(new Date(timestamp), messageId, userId, displayName, groupId, messageType, messageContent);
        response = result ? "好的！已紀錄：\n" + messageContent : '消息重複，未存檔';
        break;

      case userMessage.startsWith("/完成"):
        writeLog("執行標記完成");
        const completeTaskNumber = parseInt(userMessage.replace("/完成", "").trim());
        response = markMessageAsCompleted(completeTaskNumber);
        break;

      case userMessage.startsWith("/刪除"):
        writeLog("執行刪除訊息");
        const deleteTaskNumber = parseInt(userMessage.replace("/刪除", "").trim());
        response = deleteMessage(deleteTaskNumber);
        break;

      case userMessage === "/已完成":
        writeLog("列出已完成訊息");
        response = listCompletedMessages();
        break;
    }

    return response;

  } catch (error) {
    writeLog("Error in handleCommand: " + error.toString());
    return "處理指令時發生錯誤";
  }
}

// 幫助訊息
function getHelpMessage() {
  return "我可以幫忙大家：\n\n" +
    "/紀錄：紀錄訊息\n" +
    "/查詢：所有未處理訊息\n" +
    "/完成：標誌為已完成\n" +
    "/刪除：刪除指定訊息\n" +
    "/已完成：列出已完成";
}

// 儲存訊息
function saveMessage(timestamp, messageId, userId, displayName, groupId, messageType, messageText) {
  if (!messageText.trim()) return false;

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REMINDER_SHEET_NAME);
    if (isMessageIdExists(messageId, REMINDER_SHEET_NAME)) {
      return false;
    }

    sheet.insertRowBefore(2);
    var newRowData = [
      [timestamp, messageId, userId, displayName, groupId, messageType, "", messageText, new Date()]
    ];
    sheet.getRange(2, 1, 1, newRowData[0].length).setValues(newRowData);
    sheet.getRange(2, 1).setNumberFormat("yyyy/MM/dd HH:mm:ss");
    sheet.getRange(2, 9).setNumberFormat("yyyy/MM/dd HH:mm:ss");
    return true;
  } catch (error) {
    writeLog("Error in saveMessage: " + error.toString());
    return false;
  }
}

// 查詢未處理訊息
function queryUnprocessedMessages() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REMINDER_SHEET_NAME);
    var dataRange = sheet.getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), sheet.getLastColumn());
    var data = dataRange.getValues();
    var messages = [];
    var tempNumber = 1;

    data.forEach(function (row, index) {
      if (row[6] !== "v") {
        messages.push(tempNumber + ". " + row[7]);
        sheet.getRange(index + 2, 26).setValue(tempNumber++);
      }
    });

    return messages.length > 0 ? messages.join("\n") : "沒有未處理的訊息";
  } catch (error) {
    writeLog("Error in queryUnprocessedMessages: " + error.toString());
    return "查詢時發生錯誤";
  }
}

// 清除臨時編號
function clearTemporaryNumbers() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REMINDER_SHEET_NAME);
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 26, lastRow - 1).clearContent();
    }
  } catch (error) {
    writeLog("Error in clearTemporaryNumbers: " + error.toString());
  }
}

// 根據臨時編號找到對應的列號
function findRowNumberByTemporaryIndex(taskNumber) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REMINDER_SHEET_NAME);
    var lastRow = sheet.getLastRow();

    var tempNumbers = sheet.getRange(2, 26, lastRow - 1).getValues();

    for (var i = 0; i < tempNumbers.length; i++) {
      if (tempNumbers[i][0] === taskNumber) {
        return i + 2;
      }
    }

    return -1;
  } catch (error) {
    writeLog("在 findRowNumberByTemporaryIndex 中發生錯誤：" + error.toString());
    return -1;
  }
}

// 標記訊息為已完成
function markMessageAsCompleted(taskNumber) {
  try {
    var rowNumber = findRowNumberByTemporaryIndex(taskNumber);
    if (rowNumber === -1) {
      return "找不到編號為 " + taskNumber + " 的訊息";
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REMINDER_SHEET_NAME);
    sheet.getRange(rowNumber, 7).setValue("v");
    var completedMessage = sheet.getRange(rowNumber, 8).getValue();
    return "好的，已完成：\n" + completedMessage;
  } catch (error) {
    writeLog("Error in markMessageAsCompleted: " + error.toString());
    return "標記完成時發生錯誤";
  }
}

// 刪除指定訊息
function deleteMessage(taskNumber) {
  try {
    var rowNumber = findRowNumberByTemporaryIndex(taskNumber);
    if (rowNumber === -1) {
      return "找不到編號為 " + taskNumber + " 的訊息";
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REMINDER_SHEET_NAME);
    var deletedMessage = sheet.getRange(rowNumber, 8).getValue();
    sheet.deleteRow(rowNumber);
    return "好的，已刪除：\n" + deletedMessage;
  } catch (error) {
    writeLog("Error in deleteMessage: " + error.toString());
    return "刪除時發生錯誤";
  }
}

// 列出已完成的訊息
function listCompletedMessages() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REMINDER_SHEET_NAME);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return "沒有已完成的訊息";

    var data = sheet.getRange(2, 7, lastRow - 1, 2).getValues();
    var messages = [];
    var count = 1;

    data.forEach(function (row) {
      if (row[0] === "v") {
        messages.push(count++ + ". " + row[1]);
      }
    });

    return messages.length > 0 ? messages.join("\n") : "沒有已完成的訊息";
  } catch (error) {
    writeLog("Error in listCompletedMessages: " + error.toString());
    return "列出已完成訊息時發生錯誤";
  }
}
