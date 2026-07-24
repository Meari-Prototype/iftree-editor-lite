import { debugElapsedMs, debugLog, debugStartedAt, summarizeArgs, summarizeResult } from '../lib/debug-log.js';
import type { TypedDatabaseReadRequest, TypedDatabaseReadResult } from '../../backend/query-api.js';
import type { MutationPayload, MutationResult } from '../../backend/mutation-api.js';
import { getUiMessages } from '../../lang/ui.js';

type IftreeMethod = (...args: unknown[]) => Promise<unknown>;
type IftreeCallback = (payload: unknown) => void;
type IftreeUnsubscribe = () => void;
interface DatabaseReadMethod {
  <Request extends TypedDatabaseReadRequest>(payload: Request): Promise<TypedDatabaseReadResult<Request>>;
  (payload: Record<string, unknown>): Promise<unknown>;
}
type DatabaseWriteMethod = (payload: MutationPayload) => Promise<MutationResult>;
type IftreeApi = Record<string, IftreeMethod | ((callback: IftreeCallback) => IftreeUnsubscribe) | DatabaseReadMethod | undefined> & {
  readDatabase?: DatabaseReadMethod;
  writeDatabase?: DatabaseWriteMethod;
};

const OS_BRIDGE_METHODS = new Set([
  'minimizeWindow',
  'toggleMaximizeWindow',
  'closeWindow',
  'openEntityMaintenanceWindow',
  'chooseImportFile',
  'chooseLocalModelRoot',
  'openPath'
]);
const HTTP_UNAVAILABLE_METHODS = new Set(['chooseImportFile', 'chooseLocalModelRoot', 'openPath']);
const eventListeners = new Map<string, Set<IftreeCallback>>();
let eventSource: EventSource | null = null;

function nativeBridge(): IftreeApi {
  if (typeof window === 'undefined') return {};
  return (window.iftree as IftreeApi | undefined) || {};
}

async function callWebRpc<Result = unknown>(method: string, args: unknown[]): Promise<Result> {
  let response: Response;
  try {
    response = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args })
    });
  } catch {
    // fetch 的裸 TypeError（Failed to fetch）意味着本地服务不可达——预览服务重启或后端崩溃恢复中。
    // 给用户可操作的提示，而不是一句看不懂的 "Failed to fetch"。
    throw new Error(getUiMessages().notices.localServiceUnavailable);
  }
  const body = await (response.json() as Promise<{ ok?: boolean; result?: Result; error?: unknown }>)
    .catch(() => {
      // 后端宕机窗口内，vite 代理返回 500 纯文本（ECONNREFUSED）而非 JSON——
      // 插件探活几秒内会自动重拉，提示用户稍后重试即可，无需刷新页面。
      throw new Error(getUiMessages().notices.localBackendReconnecting);
    });
  if (!response.ok || body.ok === false) throw new Error(String(body.error || `WebUI RPC failed: ${method}`));
  return body.result as Result;
}

function ensureEventSource() {
  if (typeof window === 'undefined' || eventSource) return;
  eventSource = new EventSource('/api/events');
  eventSource.onmessage = (event) => {
    const envelope = JSON.parse(event.data || '{}') as { type?: string; payload?: unknown };
    for (const callback of eventListeners.get(String(envelope.type || '')) || []) callback(envelope.payload);
  };
}

function subscribeWebEvent(type: string, callback: IftreeCallback): IftreeUnsubscribe {
  ensureEventSource();
  const listeners = eventListeners.get(type) || new Set<IftreeCallback>();
  listeners.add(callback);
  eventListeners.set(type, listeners);
  return () => listeners.delete(callback);
}

const webApi = new Proxy({} as IftreeApi, {
  get(_target, property) {
    const name = String(property);
    if (name === 'onProgress') return (callback: IftreeCallback) => subscribeWebEvent('progress', callback);
    if (name === 'onLibraryChanged') return (callback: IftreeCallback) => subscribeWebEvent('library.changed', callback);
    if (name === 'onAgentStream') return (callback: IftreeCallback) => subscribeWebEvent('agent.stream', callback);
    return (...args: unknown[]) => callWebRpc(name, args);
  }
});

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error || '').slice(0, 240);
}

export function getIftreeApi(): IftreeApi {
  return webApi;
}

export function rawIftreeApi(): IftreeApi {
  return new Proxy(webApi, {
    get(target, property) {
      return nativeBridge()[String(property)] || target[String(property)];
    }
  });
}

export function hasIftreeMethod(name: string): boolean {
  if (OS_BRIDGE_METHODS.has(name) && HTTP_UNAVAILABLE_METHODS.has(name)) return typeof nativeBridge()[name] === 'function';
  return true;
}

export function callIftree<Result = unknown>(name: string, ...args: unknown[]): Promise<Result> {
  const bridgeFn = OS_BRIDGE_METHODS.has(name) ? nativeBridge()[name] : undefined;
  if (typeof bridgeFn !== 'function' && typeof window !== 'undefined') {
    if (name === 'closeWindow') {
      window.close();
      return Promise.resolve(undefined as Result);
    }
    if (name === 'minimizeWindow' || name === 'toggleMaximizeWindow') return Promise.resolve(undefined as Result);
  }
  if (name === 'openEntityMaintenanceWindow' && typeof bridgeFn !== 'function' && typeof window !== 'undefined') {
    const payload = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as { docId?: unknown; doc_id?: unknown };
    const url = new URL(window.location.href);
    url.searchParams.set('screen', 'entity-maintenance');
    const docId = payload.docId ?? payload.doc_id;
    if (docId) url.searchParams.set('docId', String(docId));
    window.open(url.toString(), 'iftree-entity-maintenance');
    return Promise.resolve({ ok: true } as Result);
  }
  const fn = bridgeFn || getIftreeApi()[name];
  if (typeof fn !== 'function') {
    return Promise.reject(new Error(`IFTree backend method is unavailable: ${name}`));
  }
  const startedAt = debugStartedAt();
  debugLog('renderer.ipc.start', {
    method: name,
    args: summarizeArgs(args)
  });
  return (fn as IftreeMethod)(...args)
    .then((result: unknown) => {
      debugLog('renderer.ipc.end', {
        method: name,
        ok: true,
        ms: debugElapsedMs(startedAt),
        result: summarizeResult(result)
      });
      return result as Result;
    })
    .catch((error: unknown) => {
      debugLog('renderer.ipc.end', {
        method: name,
        ok: false,
        ms: debugElapsedMs(startedAt),
        error: errorMessage(error)
      });
      throw error;
    });
}

export function subscribeIftree<Payload = unknown>(name: string, callback: (payload: Payload) => void): IftreeUnsubscribe | undefined {
  const fn = getIftreeApi()[name];
  if (typeof fn !== 'function') return undefined;
  return (fn as (callback: (payload: Payload) => void) => IftreeUnsubscribe)(callback);
}

export function minimizeWindow() {
  return callIftree('minimizeWindow');
}

export function toggleMaximizeWindow() {
  return callIftree('toggleMaximizeWindow');
}

export function closeWindow() {
  return callIftree('closeWindow');
}

export function onProgress(callback: IftreeCallback) {
  return subscribeIftree('onProgress', callback);
}

export function onLibraryChanged(callback: IftreeCallback) {
  return subscribeIftree('onLibraryChanged', callback);
}

export function onAgentStream<Payload = unknown>(callback: (payload: Payload) => void) {
  return subscribeIftree('onAgentStream', callback);
}
