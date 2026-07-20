// 商化系統主動通知閘道。TOKEN、群組 ID 與共用密鑰只存放於 Script Properties。
var MNT_ALERT_KIND = 'mnt-alert-v1';
var MNT_ALERT_GROUP_PROPERTY = 'MNT_ALERT_GROUP_ID';
var MNT_ALERT_SECRET_PROPERTY = 'MNT_ALERT_SECRET';
var MNT_ALERT_MONTHLY_LIMIT_PROPERTY = 'MNT_ALERT_MONTHLY_LIMIT';
var MNT_ALERT_RESERVED_QUOTA_PROPERTY = 'MNT_ALERT_RESERVED_QUOTA';
var MNT_ALERT_RECENT_EVENTS_PROPERTY = 'MNT_ALERT_RECENT_EVENTS';
var MNT_MERCH_STATUS_SNAPSHOT_PROPERTY = 'MNT_MERCH_STATUS_SNAPSHOT';
var MNT_ALERT_MANAGEMENT_GROUP_ID = 'C19c9d03e3605481d85c45982aa814e60';
var MNT_ALERT_DEFAULT_MONTHLY_LIMIT = 200;
var MNT_ALERT_DEFAULT_RESERVED_QUOTA = 40;
var MNT_ALERT_ALLOWED_CATEGORIES = [
  'system_down',
  'system_action_required',
  'system_recovered',
  'progress',
  'field_critical',
  'status_snapshot',
  'feature_announcement',
  'integration_test'
];
var MNT_ALERT_EMERGENCY_CATEGORIES = [
  'system_down',
  'system_action_required',
  'system_recovered',
  'integration_test'
];

function isMntAlertPayload_(payload) {
  return Boolean(payload && payload.kind === MNT_ALERT_KIND);
}

function handleMntAlertRequest_(payload) {
  try {
    var request = normalizeMntAlertRequest_(payload);
    validateMntAlertRequest_(request);
    var result = withMntAlertLock_(function() {
      return processMntAlertRequest_(request);
    });
    return mntAlertJsonResponse_(Object.assign({ ok: true }, result));
  } catch (error) {
    writeLog('商化主動通知失敗：' + (error && error.message ? error.message : error));
    return mntAlertJsonResponse_({
      ok: false,
      error: error && error.message ? error.message : String(error || '未知錯誤')
    });
  }
}

function normalizeMntAlertRequest_(payload) {
  return {
    kind: String(payload.kind || ''),
    timestamp: Number(payload.timestamp || 0),
    eventId: String(payload.eventId || '').trim().slice(0, 180),
    category: String(payload.category || '').trim(),
    message: String(payload.message || '').trim().slice(0, 1200),
    dryRun: payload.dryRun === true,
    signature: String(payload.signature || '').trim()
  };
}

function validateMntAlertRequest_(request) {
  if (!request.eventId || !request.message) throw new Error('通知事件或內容空白');
  if (MNT_ALERT_ALLOWED_CATEGORIES.indexOf(request.category) < 0) throw new Error('不支援的通知類別');
  if (!Number.isFinite(request.timestamp) || Math.abs(Date.now() - request.timestamp) > 5 * 60 * 1000) {
    throw new Error('通知已逾時');
  }
  var secret = PropertiesService.getScriptProperties().getProperty(MNT_ALERT_SECRET_PROPERTY) || '';
  if (secret.length < 32) throw new Error('通知密鑰尚未設定');
  var expected = signMntAlertRequest_(request, secret);
  if (!constantTimeEqualsMntAlert_(request.signature, expected)) throw new Error('通知簽章無效');
}

function signMntAlertRequest_(request, secret) {
  var canonical = JSON.stringify([
    request.kind,
    request.timestamp,
    request.eventId,
    request.category,
    request.message,
    request.dryRun === true
  ]);
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8)
  ).replace(/=+$/g, '');
}

function constantTimeEqualsMntAlert_(left, right) {
  var a = String(left || '');
  var b = String(right || '');
  var mismatch = a.length ^ b.length;
  var length = Math.max(a.length, b.length);
  for (var i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1, b.length)) || 0);
  }
  return mismatch === 0;
}

function processMntAlertRequest_(request) {
  var props = PropertiesService.getScriptProperties();
  if (request.category === 'status_snapshot') {
    return storeMntMerchStatusSnapshot_(request, props);
  }
  updateMntMerchServiceFromAlert_(request, props);
  if (request.category === 'field_critical' && !isMntAlertTrulyCritical_(request.message)) {
    return { suppressed: true, eventId: request.eventId, expectedCost: 0 };
  }
  var recentEvents = readRecentMntAlertEvents_(props);
  if (recentEvents.indexOf(request.eventId) >= 0) {
    return { duplicate: true, eventId: request.eventId, quota: getMntAlertQuotaSnapshot_() };
  }

  var quota = getMntAlertQuotaSnapshot_();
  var emergency = MNT_ALERT_EMERGENCY_CATEGORIES.indexOf(request.category) >= 0;
  var reserve = positiveMntAlertNumber_(props.getProperty(MNT_ALERT_RESERVED_QUOTA_PROPERTY), MNT_ALERT_DEFAULT_RESERVED_QUOTA);
  var expectedCost = Math.max(1, quota.groupMembers || 1);
  var remainingAfterSend = quota.remaining - expectedCost;
  if (remainingAfterSend < 0 || (!emergency && remainingAfterSend < reserve)) {
    throw new Error(emergency ? 'LINE 本月可用額度不足' : 'LINE 額度已保留給系統故障通知');
  }

  if (request.dryRun) {
    return { dryRun: true, eventId: request.eventId, quota: quota, expectedCost: expectedCost };
  }

  var groupId = props.getProperty(MNT_ALERT_GROUP_PROPERTY) || '';
  if (!/^C[a-f0-9]{32}$/i.test(groupId)) throw new Error('商化管理群組尚未設定');
  var response = pushMntAlertMessage_(groupId, request.message, request.eventId, request.category);
  var allLogSaved = logMntAlertSuccessToAll_(request, groupId, response, expectedCost);
  recentEvents.unshift(request.eventId);
  props.setProperty(MNT_ALERT_RECENT_EVENTS_PROPERTY, JSON.stringify(recentEvents.slice(0, 240)));
  return {
    sent: true,
    eventId: request.eventId,
    lineRequestId: response.requestId,
    allLogSaved: allLogSaved,
    quota: quota,
    expectedCost: expectedCost
  };
}

function isMntAlertTrulyCritical_(message) {
  var value = String(message || '');
  return /問題[：:]\s*(?:定位距離異常|回報無法對應本月任務)/.test(value);
}

function pauseMntMerchPush() {
  PropertiesService.getScriptProperties().deleteProperty(MNT_ALERT_GROUP_PROPERTY);
  console.log('商化 LINE PUSH 已暫停');
  return { ok: true, paused: true };
}

function configureMntMerchManagementGroup() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(MNT_ALERT_GROUP_PROPERTY, MNT_ALERT_MANAGEMENT_GROUP_ID);
  var result = inspectMntAlertQuota();
  console.log('商化管理群組已設為 ' + MNT_ALERT_MANAGEMENT_GROUP_ID);
  return result;
}

function inspectMntAlertQuota() {
  var groupId = PropertiesService.getScriptProperties().getProperty(MNT_ALERT_GROUP_PROPERTY) || '';
  var quota = getMntAlertQuotaSnapshot_();
  var result = {
    groupId: groupId,
    memberCount: /^C[a-f0-9]{32}$/i.test(groupId) ? getMntAlertGroupMemberCount_() : 0,
    quota: quota
  };
  console.log(JSON.stringify(result));
  return result;
}

function storeMntMerchStatusSnapshot_(request, props) {
  if (request.dryRun) return { dryRun: true, synced: false, eventId: request.eventId, expectedCost: 0 };
  var snapshot = parseMntAlertJson_(request.message);
  if (!snapshot || Number(snapshot.v) !== 1 || !/^\d{6}$/.test(String(snapshot.month || ''))) {
    throw new Error('商化狀態快照格式不正確');
  }
  snapshot.receivedAt = new Date(request.timestamp).toISOString();
  props.setProperty(MNT_MERCH_STATUS_SNAPSHOT_PROPERTY, JSON.stringify(snapshot));
  return { synced: true, eventId: request.eventId, expectedCost: 0 };
}

function updateMntMerchServiceFromAlert_(request, props) {
  var statuses = {
    system_down: 'down',
    system_action_required: 'degraded',
    system_recovered: 'ok'
  };
  var status = statuses[request.category];
  if (!status) return;
  var snapshot = readMntMerchStatusSnapshot_(props) || { v: 1, month: formatMntStatusMonth_(new Date(request.timestamp)) };
  snapshot.updatedAt = new Date(request.timestamp).toISOString();
  snapshot.service = {
    status: status,
    summary: String(request.message || '').split('\n').slice(0, 3).join('｜').slice(0, 240),
    checkedAt: new Date(request.timestamp).toISOString()
  };
  props.setProperty(MNT_MERCH_STATUS_SNAPSHOT_PROPERTY, JSON.stringify(snapshot));
}

function readMntMerchStatusSnapshot_(props) {
  try {
    var parsed = JSON.parse((props || PropertiesService.getScriptProperties()).getProperty(MNT_MERCH_STATUS_SNAPSHOT_PROPERTY) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function buildMntMerchStatusReply_(groupId) {
  var props = PropertiesService.getScriptProperties();
  var allowedGroupId = props.getProperty(MNT_ALERT_GROUP_PROPERTY) || '';
  if (!groupId || groupId !== allowedGroupId) return '此指令只提供商化管理群組使用。';
  var snapshot = readMntMerchStatusSnapshot_(props);
  if (!snapshot) return '商化狀態尚未同步，請稍後再輸入 /商化。';
  var progress = snapshot.progress || {};
  var service = snapshot.service || {};
  var issues = snapshot.issues || {};
  var links = snapshot.links || {};
  var managerBase = String(links.manager || '').replace(/[?&]page=[^&]*/g, '');
  var updatedAt = new Date(snapshot.updatedAt || snapshot.receivedAt || 0);
  var stale = !Number.isFinite(updatedAt.getTime()) || Date.now() - updatedAt.getTime() > 15 * 60 * 1000;
  var serviceLabel = service.status === 'ok' ? '正常' : service.status === 'degraded' ? '部分功能異常' : service.status === 'down' ? '服務中斷' : '待確認';
  var lines = [
    '【MNT 商化即時狀態】',
    stale ? '⚠ 狀態超過 15 分鐘未更新' : '服務：' + serviceLabel,
    '進度：' + Number(progress.reported || 0) + ' / ' + Number(progress.total || 0) + ' 店（' + Number(progress.percent || 0) + '%）',
    '待回報：' + Number(progress.unreported || 0) + ' 店',
    '待處理：照片 ' + Number(issues.photo || 0) + '｜GPS ' + Number(issues.gps || 0) + '｜任務 ' + Number(issues.task || 0) + '｜其他 ' + Number(issues.other || 0),
    '更新：' + formatMntStatusTime_(updatedAt)
  ];
  if (managerBase) {
    lines.push('即時回應：' + managerBase + '?page=situation');
    lines.push('商化查詢：' + managerBase + '?page=dashboard');
    lines.push('照片查詢：' + managerBase + '?page=photos');
    lines.push('型號管理：' + managerBase + '?page=models');
  } else {
    if (links.situation) lines.push('即時回應：' + links.situation);
    if (links.dashboard) lines.push('商化查詢：' + links.dashboard);
    if (links.photos) lines.push('照片查詢：' + links.photos);
    if (links.models) lines.push('型號管理：' + links.models);
  }
  if (links.fieldReport) lines.push('前線回報：' + links.fieldReport);
  if (links.guide) lines.push('回報說明：' + links.guide);
  return lines.join('\n').slice(0, 4500);
}

function formatMntStatusMonth_(date) {
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyyMM');
}

function formatMntStatusTime_(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '未知';
  return Utilities.formatDate(date, 'Asia/Taipei', 'MM/dd HH:mm');
}

function logMntAlertSuccessToAll_(request, groupId, response, expectedCost) {
  var result = [
    'PUSH成功',
    '類別：' + request.category,
    '預估額度：' + expectedCost,
    response.requestId ? 'LINE請求編號：' + response.requestId : ''
  ].filter(Boolean).join('｜');
  try {
    return logAllMessages(
      new Date(request.timestamp || Date.now()),
      'MNT_PUSH:' + request.eventId,
      '',
      'MNT 商化系統',
      groupId,
      '主動通知/' + request.category,
      request.message,
      result
    ) === true;
  } catch (error) {
    writeLog('商化主動通知已送出，但 ALL 寫入失敗：' + (error && error.message ? error.message : error));
    return false;
  }
}

function pushMntAlertMessage_(groupId, message, eventId, category) {
  var token = getToken();
  if (!token) throw new Error('LINE TOKEN 尚未設定');
  var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      'X-Line-Retry-Key': mntAlertRetryKey_(eventId)
    },
    payload: JSON.stringify({
      to: groupId,
      messages: [{ type: 'text', text: message }],
      notificationDisabled: false,
      customAggregationUnits: ['mnt_' + String(category || 'alert').replace(/[^a-z0-9_]/gi, '_').slice(0, 24)]
    }),
    muteHttpExceptions: true
  });
  var statusCode = response.getResponseCode();
  if (statusCode < 200 || statusCode >= 300) {
    var detail = parseMntAlertJson_(response.getContentText());
    throw new Error('LINE PUSH 失敗 HTTP ' + statusCode + (detail.message ? '：' + detail.message : ''));
  }
  var headers = response.getAllHeaders ? response.getAllHeaders() : {};
  return { requestId: headers['x-line-request-id'] || headers['X-Line-Request-Id'] || '' };
}

function getMntAlertQuotaSnapshot_() {
  var props = PropertiesService.getScriptProperties();
  var configuredLimit = positiveMntAlertNumber_(props.getProperty(MNT_ALERT_MONTHLY_LIMIT_PROPERTY), MNT_ALERT_DEFAULT_MONTHLY_LIMIT);
  var quotaResponse = fetchMntAlertLineJson_('https://api.line.me/v2/bot/message/quota');
  var usageResponse = fetchMntAlertLineJson_('https://api.line.me/v2/bot/message/quota/consumption');
  var lineLimit = quotaResponse.type === 'limited' && Number(quotaResponse.value) > 0 ? Number(quotaResponse.value) : configuredLimit;
  var limit = Math.min(configuredLimit, lineLimit);
  var usage = Math.max(0, Number(usageResponse.totalUsage || 0));
  var groupMembers = getMntAlertGroupMemberCount_();
  return {
    limit: limit,
    usage: usage,
    remaining: Math.max(0, limit - usage),
    groupMembers: groupMembers
  };
}

function getMntAlertGroupMemberCount_() {
  var groupId = PropertiesService.getScriptProperties().getProperty(MNT_ALERT_GROUP_PROPERTY) || '';
  if (!groupId) return 0;
  try {
    var result = fetchMntAlertLineJson_('https://api.line.me/v2/bot/group/' + encodeURIComponent(groupId) + '/members/count');
    return Math.max(0, Number(result.count || 0));
  } catch (error) {
    return 10;
  }
}

function fetchMntAlertLineJson_(url) {
  var token = getToken();
  if (!token) throw new Error('LINE TOKEN 尚未設定');
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  var statusCode = response.getResponseCode();
  var result = parseMntAlertJson_(response.getContentText());
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('LINE 額度查詢失敗 HTTP ' + statusCode + (result.message ? '：' + result.message : ''));
  }
  return result;
}

function readRecentMntAlertEvents_(props) {
  try {
    var parsed = JSON.parse(props.getProperty(MNT_ALERT_RECENT_EVENTS_PROPERTY) || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (error) {
    return [];
  }
}

function mntAlertRetryKey_(eventId) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(eventId || ''), Utilities.Charset.UTF_8);
  var hex = digest.map(function(value) {
    return ('0' + ((value + 256) % 256).toString(16)).slice(-2);
  }).join('').slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), '4' + hex.slice(13, 16), 'a' + hex.slice(17, 20), hex.slice(20, 32)].join('-');
}

function positiveMntAlertNumber_(value, fallback) {
  var number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function withMntAlertLock_(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function parseMntAlertJson_(text) {
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    return {};
  }
}

function mntAlertJsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
