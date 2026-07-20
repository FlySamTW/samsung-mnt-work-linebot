// 商化系統主動通知閘道。TOKEN、群組 ID 與共用密鑰只存放於 Script Properties。
var MNT_ALERT_KIND = 'mnt-alert-v1';
var MNT_ALERT_GROUP_PROPERTY = 'MNT_ALERT_GROUP_ID';
var MNT_ALERT_SECRET_PROPERTY = 'MNT_ALERT_SECRET';
var MNT_ALERT_MONTHLY_LIMIT_PROPERTY = 'MNT_ALERT_MONTHLY_LIMIT';
var MNT_ALERT_RESERVED_QUOTA_PROPERTY = 'MNT_ALERT_RESERVED_QUOTA';
var MNT_ALERT_RECENT_EVENTS_PROPERTY = 'MNT_ALERT_RECENT_EVENTS';
var MNT_ALERT_DEFAULT_MONTHLY_LIMIT = 200;
var MNT_ALERT_DEFAULT_RESERVED_QUOTA = 40;
var MNT_ALERT_ALLOWED_CATEGORIES = [
  'system_down',
  'system_action_required',
  'system_recovered',
  'progress',
  'field_critical',
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
  recentEvents.unshift(request.eventId);
  props.setProperty(MNT_ALERT_RECENT_EVENTS_PROPERTY, JSON.stringify(recentEvents.slice(0, 240)));
  return {
    sent: true,
    eventId: request.eventId,
    lineRequestId: response.requestId,
    quota: quota,
    expectedCost: expectedCost
  };
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
