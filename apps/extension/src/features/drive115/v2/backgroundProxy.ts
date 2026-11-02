/**
 * @file backgroundProxy.ts
 * @description backgroundProxy
 * @module features/drive115
 */
// src/features/drive115/v2/backgroundProxy.ts
// 抽离 115 v2 后台代理（解决内容脚本 CORS）
import {
  extractStreamUrlFromPlayResponse,
  inferDrive115StreamType,
  maskDrive115StreamUrlForLog,
  type Drive115PlaybackEndpointKind,
} from './streamResponse';

function logDrive115Proxy(message: string, data?: any): void {
  try {
    if (data !== undefined) console.info(`[115Proxy] ${message}`, data);
    else console.info(`[115Proxy] ${message}`);
  } catch {}
}

/**
 * 以宿主全局（WorkerGlobalScope / self）为 this 调用 fetch。
 *
 * MV3 Service Worker 中个别环境下在模块内裸调 `fetch(...)` 会丢失宿主 this 绑定并抛
 * `TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation`。
 * 该后台代理运行在 Service Worker，是 115 open API 的主执行路径（dashboard 经
 * chrome.runtime 转发到此），必须统一经由此处绑定宿主全局再调用。
 */
function nativeFetch(input: any, init?: any): Promise<Response> {
  const target = (globalThis as any).fetch;
  return Function.prototype.apply.call(target, globalThis, init === undefined ? [input] : [input, init]);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const source = bytes.slice().buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-1', source);
  return bytesToHex(new Uint8Array(digest)).toUpperCase();
}

async function hmacSha1Base64(secret: string, value: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(secret).buffer as ArrayBuffer;
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const message = new TextEncoder().encode(value).buffer as ArrayBuffer;
  const signature = await crypto.subtle.sign('HMAC', key, message);
  return bytesToBase64(new Uint8Array(signature));
}

export async function uploadRemoteImageTo115(payload: any): Promise<{ success: boolean; message?: string; fileId?: string; fileName?: string }> {
  const accessToken = String(payload.accessToken || '').trim();
  const sourceUrl = String(payload.sourceUrl || '').trim();
  const parentId = String(payload.parentId ?? '0').trim() || '0';
  const fileName = String(payload.fileName || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 200);
  const base = String(payload.baseUrl || 'https://proapi.115.com').replace(/\/+$/, '');
  if (!accessToken || !sourceUrl || !fileName) return { success: false, message: '缺少图片上传参数' };
  let parsedSource: URL;
  try { parsedSource = new URL(sourceUrl); } catch { return { success: false, message: '图片地址无效' }; }
  if (parsedSource.protocol !== 'https:') return { success: false, message: '图片地址必须使用 HTTPS' };
  const sourceHost = parsedSource.hostname.toLowerCase();
  const allowedImageHost = sourceHost === 'javdb.com'
    || sourceHost.endsWith('.javdb.com')
    || sourceHost === 'javdb.net'
    || sourceHost.endsWith('.javdb.net')
    || sourceHost === 'javdb570.com'
    || sourceHost.endsWith('.javdb570.com')
    || sourceHost === 'javdb575.com'
    || sourceHost.endsWith('.javdb575.com')
    || sourceHost === 'jdbstatic.com'
    || sourceHost.endsWith('.jdbstatic.com');
  if (!allowedImageHost) return { success: false, message: '图片来源域名不在 JavDB 白名单内' };

  try {
    const imageResponse = await nativeFetch(parsedSource.toString(), { method: 'GET', headers: { Accept: 'image/*' } });
    if (!imageResponse.ok) return { success: false, message: '下载图片失败 (' + imageResponse.status + ')' };
    const contentType = String(imageResponse.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) return { success: false, message: '资源不是图片文件' };
    const buffer = await imageResponse.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > 10 * 1024 * 1024) return { success: false, message: '图片为空或超过 10 MB 限制' };
    const bytes = new Uint8Array(buffer);
    const fileId = await sha1Hex(bytes);
    const preId = await sha1Hex(bytes.subarray(0, Math.min(bytes.length, 128 * 1024)));

    const postInit = async (signKey?: string, signVal?: string): Promise<any> => {
      const form = new FormData();
      form.set('file_name', fileName);
      form.set('file_size', String(bytes.byteLength));
      form.set('target', 'U_1_' + parentId);
      form.set('fileid', fileId);
      form.set('preid', preId);
      if (signKey) form.set('sign_key', signKey);
      if (signVal) form.set('sign_val', signVal);
      const response = await nativeFetch(base + '/open/upload/init', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
        body: form,
      });
      const raw: any = await response.json().catch(() => ({}));
      if (!response.ok || raw.state === false) throw new Error(raw.message || raw.error || '115 上传初始化失败 (' + response.status + ')');
      const data = raw.data;
      return Array.isArray(data) ? (data[0] || {}) : (data || raw);
    };

    let init = await postInit();
    let status = Number(init.status || 0);
    if (status === 2) return { success: true, fileId: String(init.file_id || ''), fileName };
    if ([6, 7, 8].includes(status)) {
      const parts = String(init.sign_check || '').split('-').map((value: string) => Number(value));
      const start = parts[0];
      const end = parts[1];
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= bytes.length) {
        return { success: false, message: '115 上传二次校验范围无效' };
      }
      const signVal = await sha1Hex(bytes.subarray(start, end + 1));
      init = await postInit(String(init.sign_key || ''), signVal);
      status = Number(init.status || 0);
      if (status === 2) return { success: true, fileId: String(init.file_id || ''), fileName };
    }

    const tokenResponse = await nativeFetch(base + '/open/upload/get_token', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    });
    const tokenRaw: any = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || tokenRaw.state === false) throw new Error(tokenRaw.message || tokenRaw.error || '获取 115 上传凭据失败');
    const uploadToken = Array.isArray(tokenRaw.data) ? tokenRaw.data[0] : (tokenRaw.data || tokenRaw);
    const endpointValue = String(uploadToken.endpoint || '').trim();
    const bucket = String(init.bucket || '').trim();
    const object = String(init.object || '').replace(/^\/+/, '');
    const secret = String(uploadToken.AccessKeySecret || uploadToken.AccessKeySecrett || '').trim();
    const accessKeyId = String(uploadToken.AccessKeyId || '').trim();
    const securityToken = String(uploadToken.SecurityToken || '').trim();
    if (!endpointValue || !bucket || !object || !secret || !accessKeyId || !securityToken) {
      return { success: false, message: '115 上传凭据或初始化结果不完整' };
    }
    const callbackContainer = Array.isArray(init.callback) ? init.callback[0] : init.callback;
    const callbackValue = callbackContainer?.value || callbackContainer;
    const callback = String(callbackValue?.callback || '').trim();
    const callbackVar = String(callbackValue?.callback_var || '').trim();
    if (!callback) return { success: false, message: '115 上传初始化未返回 callback' };
    const endpoint = new URL(endpointValue.includes('://') ? endpointValue : 'https://' + endpointValue);
    const host = endpoint.host.startsWith(bucket + '.') ? endpoint.host : bucket + '.' + endpoint.host;
    const encodedObject = object.split('/').map((part: string) => encodeURIComponent(part)).join('/');
    const uploadUrl = endpoint.protocol + '//' + host + '/' + encodedObject;
    const callbackHeader = utf8ToBase64(callback);
    const callbackVarHeader = callbackVar ? utf8ToBase64(callbackVar) : '';
    const ossDate = new Date().toUTCString();
    const canonicalHeaders = [
      'x-oss-callback:' + callbackHeader + '\n',
      ...(callbackVarHeader ? ['x-oss-callback-var:' + callbackVarHeader + '\n'] : []),
      'x-oss-date:' + ossDate + '\n',
      'x-oss-security-token:' + securityToken + '\n',
    ].join('');
    const canonicalResource = '/' + bucket + '/' + encodedObject;
    const stringToSign = 'PUT\n\n' + contentType + '\n\n' + canonicalHeaders + canonicalResource;
    const signature = await hmacSha1Base64(secret, stringToSign);
    const headers: Record<string, string> = {
      Authorization: 'OSS ' + accessKeyId + ':' + signature,
      'Content-Type': contentType,
      'x-oss-security-token': securityToken,
      'x-oss-date': ossDate,
      'x-oss-callback': callbackHeader,
    };
    if (callbackVarHeader) headers['x-oss-callback-var'] = callbackVarHeader;
    const uploadResponse = await nativeFetch(uploadUrl, { method: 'PUT', headers, body: bytes });
    const uploadBody = await uploadResponse.text().catch(() => '');
    if (!uploadResponse.ok) {
      return { success: false, message: '上传图片到 115 OSS 失败 (' + uploadResponse.status + '): ' + uploadBody.slice(0, 180) };
    }
    if (uploadBody) {
      try {
        const callbackResult = JSON.parse(uploadBody);
        if (callbackResult?.state === false) {
          return { success: false, message: callbackResult.message || '115 图片上传回调失败' };
        }
      } catch {
        // OSS 在部分成功场景返回空文本或非 JSON 文本；HTTP 2xx 仍视为已上传。
      }
    }
    return { success: true, fileId: String(init.file_id || ''), fileName };
  } catch (error: any) {
    return { success: false, message: friendlyRequestError(error, error?.message || '115 图片上传失败') };
  }
}

/**
 * 将底层平台错误翻译成可读文案，避免把
 * "Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation"
 * 这类底层细节直接透传到界面卡片。
 */
function friendlyRequestError(e: any, fallback = ''): string {
  const msg = e instanceof Error ? e.message : String(e || '');
  if (/illegal invocation/i.test(msg)) {
    return '当前运行环境无法发起该请求（后台代理异常），请稍后重试或检查扩展后台是否正常';
  }
  if (/failed to fetch|networkerror|load failed|network request failed|timed? ?out|timeout/i.test(msg)) {
    return '网络异常，无法连接 115 服务，请稍后重试';
  }
  return msg || fallback;
}

export function installDrive115V2Proxy(): void {
  try {
    // 避免重复注册
    // @ts-ignore
    const __drive115_v2_proxy_flag = (globalThis as any).__drive115_v2_proxy_flag;
    if (!__drive115_v2_proxy_flag && typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      // @ts-ignore
      (globalThis as any).__drive115_v2_proxy_flag = true;
      chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse): boolean | void => {
        if (!message || typeof message !== 'object') return false;
        if (message.type === 'drive115.add_task_urls_v2') {
          const payload = message.payload || {};
          const accessToken = String(payload.accessToken || '').trim();
          const urls = String(payload.urls || '');
          const wp_path_id = payload.wp_path_id;
          const base = String(payload.baseUrl || 'https://proapi.115.com').replace(/\/$/, '');
          const correlationId = String(payload.correlationId || '').trim();
          const taskId = String(payload.taskId || '').trim();
          if (!accessToken || !urls) {
            sendResponse({ success: false, message: '缺少 accessToken 或 urls' });
            return false;
          }

          const fd = new FormData();
          fd.set('urls', urls);
          if (wp_path_id !== undefined) fd.set('wp_path_id', String(wp_path_id));

          const fetchStartedAt = Date.now();
          const slowWarnMs = 10000;
          const slowWarnTimer = setTimeout(() => {
            logDrive115Proxy('add_task_urls still pending', {
              taskId,
              correlationId,
              waitedMs: Date.now() - fetchStartedAt,
              wp_path_id: wp_path_id ?? 'root',
            });
          }, slowWarnMs);

          logDrive115Proxy('add_task_urls fetch start', {
            taskId,
            correlationId,
            wp_path_id: wp_path_id ?? 'root',
            startedAt: fetchStartedAt,
          });

          nativeFetch(`${base}/open/offline/add_task_urls`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Accept': 'application/json'
            },
            body: fd,
          })
            .then(async (res) => {
              clearTimeout(slowWarnTimer);
              const raw = await res.json().catch(() => ({} as any));
              const ok = typeof raw.state === 'boolean' ? raw.state : res.ok;
              const data = (raw && (raw.data || raw.result)) || undefined;
              logDrive115Proxy('add_task_urls fetch done', {
                taskId,
                correlationId,
                ok,
                status: res.status,
                durationMs: Date.now() - fetchStartedAt,
              });
              sendResponse({ success: ok, message: raw?.message || raw?.error, raw, data });
            })
            .catch((err) => {
              clearTimeout(slowWarnTimer);
              logDrive115Proxy('add_task_urls fetch error', {
                taskId,
                correlationId,
                durationMs: Date.now() - fetchStartedAt,
                error: err?.message || String(err),
              });
              sendResponse({ success: false, message: friendlyRequestError(err, '后台请求失败') });
            });
          return true; // 异步响应
        } else if (message.type === 'drive115.refresh_token_v2') {
          try {
            const rt = String(message?.payload?.refreshToken || '').trim();
            const refreshBase = 'https://passportapi.115.com';
            if (!rt) {
              sendResponse({ success: false, message: '缺少 refresh_token' });
              return false;
            }
            const fd = new URLSearchParams();
            fd.set('refresh_token', rt);
            nativeFetch(`${refreshBase}/open/refreshToken`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
              body: fd.toString(),
            })
              .then(async (res) => {
                const raw = await res.json().catch(() => ({} as any));
                const ok = typeof raw.state === 'boolean' ? raw.state : res.ok;
                sendResponse({ success: ok, raw });
              })
              .catch((err) => {
                sendResponse({ success: false, message: friendlyRequestError(err, '后台刷新请求失败') });
              });
            return true; // 异步响应
          } catch (e: any) {
            sendResponse({ success: false, message: e?.message || '后台刷新异常' });
            return false;
          }
        } else if (message.type === 'drive115.auth_device_code_v2') {
          try {
            const clientId = String(message?.payload?.clientId || '').trim();
            const codeChallenge = String(message?.payload?.codeChallenge || '').trim();
            const codeChallengeMethod = String(message?.payload?.codeChallengeMethod || 'sha256').trim() || 'sha256';
            if (!clientId || !codeChallenge) {
              sendResponse({ success: false, message: '缺少 client_id 或 code_challenge' });
              return false;
            }
            const fd = new URLSearchParams();
            fd.set('client_id', clientId);
            fd.set('code_challenge', codeChallenge);
            fd.set('code_challenge_method', codeChallengeMethod);
            nativeFetch('https://passportapi.115.com/open/authDeviceCode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
              body: fd.toString(),
            })
              .then(async (res) => {
                const raw = await res.json().catch(() => ({} as any));
                const ok = !!(raw?.data?.uid) || (typeof raw?.state === 'boolean' ? raw.state : res.ok);
                sendResponse({ success: ok, message: raw?.message || raw?.error, raw });
              })
              .catch((err) => {
                sendResponse({ success: false, message: friendlyRequestError(err, '后台获取扫码信息失败') });
              });
            return true;
          } catch (e: any) {
            sendResponse({ success: false, message: e?.message || '后台获取扫码信息异常' });
            return false;
          }
        } else if (message.type === 'drive115.poll_auth_status_v2') {
          try {
            const uid = String(message?.payload?.uid || '').trim();
            const time = String(message?.payload?.time || '').trim();
            const sign = String(message?.payload?.sign || '').trim();
            if (!uid || !time || !sign) {
              sendResponse({ success: false, message: '缺少 uid、time 或 sign' });
              return false;
            }
            const url = new URL('https://qrcodeapi.115.com/get/status/');
            url.searchParams.set('uid', uid);
            url.searchParams.set('time', time);
            url.searchParams.set('sign', sign);
            nativeFetch(url.toString(), {
              method: 'GET',
              headers: { 'Accept': 'application/json' },
            })
              .then(async (res) => {
                const raw = await res.json().catch(() => ({} as any));
                const ok = raw?.state !== undefined || (typeof raw?.code === 'number') || res.ok;
                sendResponse({ success: ok, message: raw?.message || raw?.error, raw });
              })
              .catch((err) => {
                sendResponse({ success: false, message: friendlyRequestError(err, '后台轮询扫码状态失败') });
              });
            return true;
          } catch (e: any) {
            sendResponse({ success: false, message: e?.message || '后台轮询扫码状态异常' });
            return false;
          }
        } else if (message.type === 'drive115.exchange_device_code_v2') {
          try {
            const uid = String(message?.payload?.uid || '').trim();
            const codeVerifier = String(message?.payload?.codeVerifier || '').trim();
            if (!uid || !codeVerifier) {
              sendResponse({ success: false, message: '缺少 uid 或 code_verifier' });
              return false;
            }
            const fd = new URLSearchParams();
            fd.set('uid', uid);
            fd.set('code_verifier', codeVerifier);
            nativeFetch('https://passportapi.115.com/open/deviceCodeToToken', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
              body: fd.toString(),
            })
              .then(async (res) => {
                const raw = await res.json().catch(() => ({} as any));
                const token = raw?.data || raw;
                const ok = !!token?.access_token || (typeof raw?.state === 'boolean' ? raw.state : res.ok);
                sendResponse({ success: ok, message: raw?.message || raw?.error, raw });
              })
              .catch((err) => {
                sendResponse({ success: false, message: friendlyRequestError(err, '后台换取 token 失败') });
              });
            return true;
          } catch (e: any) {
            sendResponse({ success: false, message: e?.message || '后台换取 token 异常' });
            return false;
          }
        } else if (message.type === 'drive115.list_files_v2') {
          try {
            const accessToken = String(message?.payload?.accessToken || '').trim();
            const base = String(message?.payload?.baseUrl || 'https://proapi.115.com').replace(/\/$/, '');
            const query = message?.payload?.query || {};
            if (!accessToken) {
              sendResponse({ success: false, message: '缺少 access_token' });
              return false;
            }

            const url = new URL(`${base}/open/ufile/files`);
            Object.entries(query).forEach(([key, value]) => {
              if (value !== undefined && value !== null && String(value).trim() !== '') {
                url.searchParams.set(key, String(value));
              }
            });

            nativeFetch(url.toString(), {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
              },
            }).then(async (res) => {
              const raw = await res.json().catch(() => ({} as any));
              const ok = typeof raw.state === 'boolean' ? raw.state : res.ok;
              sendResponse({
                success: ok,
                message: raw?.message || raw?.error,
                raw,
                data: raw?.data,
                path: raw?.path,
              });
            }).catch((err) => {
              sendResponse({ success: false, message: friendlyRequestError(err, '后台文件列表请求失败') });
            });
            return true;
          } catch (e: any) {
            sendResponse({ success: false, message: e?.message || '后台文件列表异常' });
            return false;
          }
        } else if (message.type === 'drive115.get_quota_info_v2') {
          try {
            const accessToken = String(message?.payload?.accessToken || '').trim();
            const base = String(message?.payload?.baseUrl || 'https://proapi.115.com').replace(/\/$/, '');
            if (!accessToken) {
              sendResponse({ success: false, message: '缺少 access_token' });
              return false;
            }
            nativeFetch(`${base}/open/offline/get_quota_info`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
              },
            }).then(async (res) => {
              const raw = await res.json().catch(() => ({} as any));
              const ok = typeof raw.state === 'boolean' ? raw.state : res.ok;
              sendResponse({ success: ok, raw });
            }).catch((err) => {
              sendResponse({ success: false, message: friendlyRequestError(err, '后台配额请求失败') });
            });
            return true; // 异步响应
          } catch (e: any) {
            sendResponse({ success: false, message: e?.message || '后台配额异常' });
            return false;
          }
        } else if (message.type === 'drive115.upload_remote_image_v2') {
          const payload = message?.payload || {};
          void uploadRemoteImageTo115(payload)
            .then((result) => sendResponse(result))
            .catch((error) => sendResponse({ success: false, message: friendlyRequestError(error, '115 图片上传失败') }));
          return true;
        } else if (message.type === 'drive115.manage_files_v2') {
          try {
            const payload = message?.payload || {};
            const accessToken = String(payload.accessToken || '').trim();
            const base = String(payload.baseUrl || 'https://proapi.115.com').replace(/\/$/, '');
            const action = String(payload.action || '').trim();
            if (!accessToken) {
              sendResponse({ success: false, message: '缺少 accessToken' });
              return false;
            }

            const form = new FormData();
            let endpoint = '';
            if (action === 'create_folder') {
              endpoint = `${base}/open/folder/add`;
              form.set('pid', String(payload.parentId ?? '0'));
              form.set('file_name', String(payload.fileName || '').trim());
            } else if (action === 'rename_file') {
              endpoint = `${base}/open/ufile/update`;
              form.set('file_id', String(payload.fileId || '').trim());
              form.set('file_name', String(payload.fileName || '').trim());
            } else if (action === 'move_files') {
              endpoint = `${base}/open/ufile/move`;
              const fileIds = Array.isArray(payload.fileIds)
                ? payload.fileIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
                : [];
              form.set('file_ids', fileIds.join(','));
              form.set('to_cid', String(payload.targetFolderId ?? '0'));
            } else {
              sendResponse({ success: false, message: '不支持的文件管理操作' });
              return false;
            }

            const requiredFieldsValid = action === 'create_folder'
              ? Boolean(String(payload.fileName || '').trim())
              : action === 'rename_file'
                ? Boolean(String(payload.fileId || '').trim() && String(payload.fileName || '').trim())
                : Boolean(Array.isArray(payload.fileIds) && payload.fileIds.length);
            if (!requiredFieldsValid) {
              sendResponse({ success: false, message: '文件管理参数不完整' });
              return false;
            }

            nativeFetch(endpoint, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
              },
              body: form,
            }).then(async (res) => {
              const raw = await res.json().catch(() => ({} as any));
              const ok = (typeof raw.state === 'boolean' ? raw.state : res.ok) && res.ok;
              sendResponse({
                success: ok,
                message: ok ? undefined : (raw?.message || raw?.error || `文件管理操作失败 (${res.status})`),
                data: raw?.data,
                raw,
                endpoint,
              });
            }).catch((err) => {
              sendResponse({ success: false, message: friendlyRequestError(err, '后台文件管理请求失败') });
            });
            return true;
          } catch (e: any) {
            sendResponse({ success: false, message: e?.message || '后台文件管理异常' });
            return false;
          }
        } else if (message.type === 'drive115.delete_files_v2') {
          try {
            const accessToken = String(message?.payload?.accessToken || '').trim();
            const base = String(message?.payload?.baseUrl || 'https://proapi.115.com').replace(/\/$/, '');
            const fileIds = Array.isArray(message?.payload?.fileIds)
              ? message.payload.fileIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
              : [];
            if (!accessToken || !fileIds.length) {
              sendResponse({ success: false, message: '缺少 accessToken 或 fileIds' });
              return false;
            }
            const endpoints = [`${base}/open/rb/delete`, `${base}/open/ufile/delete`];
            const tryNext = (idx: number) => {
              if (idx >= endpoints.length) {
                sendResponse({ success: false, message: '删除接口均不可用' });
                return;
              }
              const url = endpoints[idx];
              const fd = new FormData();
              fd.set('file_id', fileIds.join(','));
              fd.set('file_ids', fileIds.join(','));
              nativeFetch(url, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: 'application/json',
                },
                body: fd,
              })
                .then(async (res) => {
                  const raw = await res.json().catch(() => ({} as any));
                  const ok = (typeof raw.state === 'boolean' ? raw.state : res.ok) && res.ok;
                  if (ok) {
                    sendResponse({ success: true, raw, endpoint: url });
                    return;
                  }
                  if (idx + 1 < endpoints.length) {
                    tryNext(idx + 1);
                    return;
                  }
                  sendResponse({
                    success: false,
                    message: raw?.message || raw?.error || `删除失败 (${res.status})`,
                    raw,
                    endpoint: url,
                  });
                })
                .catch((err) => {
                  if (idx + 1 < endpoints.length) {
                    tryNext(idx + 1);
                    return;
                  }
                  sendResponse({ success: false, message: friendlyRequestError(err, '后台删除请求失败') });
                });
            };
            tryNext(0);
            return true;
          } catch (e: any) {
            sendResponse({ success: false, message: e?.message || '后台删除异常' });
            return false;
          }
        } else if (message.type === 'drive115.video_play_v2') {
          try {
            const accessToken = String(message?.payload?.accessToken || '').trim();
            const pickCode = String(message?.payload?.pickCode || '').trim();
            const base = String(message?.payload?.baseUrl || 'https://proapi.115.com').replace(/\/$/, '');
            if (!accessToken || !pickCode) {
              sendResponse({ success: false, message: '缺少 accessToken 或 pickCode' });
              return false;
            }
            const endpoints: Array<{ url: string; kind: Drive115PlaybackEndpointKind; init: () => RequestInit }> = [
              // ????????????? <video> ???????? CDN MP4?
              // ?? /open/video/play ?? HLS ?? m3u8 ?? CORS/Referer ?????
              {
                url: `${base}/open/ufile/downurl`,
                kind: 'downurl',
                init: () => {
                  const body = new FormData();
                  body.set('pick_code', pickCode);
                  return { method: 'POST', body };
                },
              },
              {
                url: `${base}/open/video/play?pick_code=${encodeURIComponent(pickCode)}`,
                kind: 'video_play',
                init: () => ({ method: 'GET' }),
              },
              {
                url: `${base}/open/video/play?pickcode=${encodeURIComponent(pickCode)}`,
                kind: 'video_play',
                init: () => ({ method: 'GET' }),
              },
              {
                url: `${base}/open/video/play`,
                kind: 'video_play',
                init: () => {
                  const body = new FormData();
                  body.set('pick_code', pickCode);
                  return { method: 'POST', body };
                },
              },
            ];

            const extractUrl = (json: unknown): string | undefined => extractStreamUrlFromPlayResponse(json);
            const tryNext = (idx: number) => {
              if (idx >= endpoints.length) {
                sendResponse({ success: false, message: '取流接口均不可用' });
                return;
              }
              const endpoint = endpoints[idx];
              nativeFetch(endpoint.url, {
                ...endpoint.init(),
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: 'application/json',
                },
              })
                .then(async (res) => {
                  const raw = await res.json().catch(() => ({} as any));
                  const ok = (typeof raw.state === 'boolean' ? raw.state : res.ok) && res.ok;
                  const streamUrl = ok ? extractUrl(raw) : undefined;
                  if (streamUrl) {
                    const streamType = inferDrive115StreamType({
                      url: streamUrl,
                      raw,
                      endpointKind: endpoint.kind,
                      endpoint: endpoint.url,
                    });
                    const debugSafeUrl = maskDrive115StreamUrlForLog(streamUrl);
                    sendResponse({ success: true, streamUrl, streamType, raw, endpoint: endpoint.url, debugSafeUrl });
                    return;
                  }
                  if (idx + 1 < endpoints.length) {
                    tryNext(idx + 1);
                    return;
                  }
                  sendResponse({
                    success: false,
                    message: raw?.message || raw?.error || '响应中无播放地址',
                    raw,
                    endpoint: endpoint.url,
                  });
                })
                .catch(() => {
                  if (idx + 1 < endpoints.length) tryNext(idx + 1);
                  else sendResponse({ success: false, message: '后台取流请求失败' });
                });
            };
            tryNext(0);
            return true;
          } catch (e: any) {
            sendResponse({ success: false, message: e?.message || '后台取流异常' });
            return false;
          }
        }
        // 未匹配任何 115 v2 消息类型
        return false;
      });
    }
  } catch (e) {
    // 静默
  }
}
