export { request } from './http/request.js';
export { HttpResponse } from './http/response.js';
export type { FetchOptions } from './http/options.js';
export { setProxy, getProxy, getBypass, validateProxy } from './http/proxy.js';
export { setAuditSink, recordOutbound, noteError } from './http/audit.js';
export type { Audit, AuditSink } from './http/audit.js';
