declare const __QUOTAHOT_VERSION__: string | undefined;

export const APP_VERSION = typeof __QUOTAHOT_VERSION__ === 'string' ? __QUOTAHOT_VERSION__ : 'dev';
