/**
 * 内嵌的前端资源。
 *
 * 这里故意是空的：直接跑源码时前端在 dist/ 目录里，由 main.ts 走文件系统托管。
 * 打包时 scripts/build.mjs 会把这个模块整个换成一张装着构建产物的表，
 * 于是产物自己就带着界面，不必再随身拖一个 assets 目录——单文件可执行全靠这一点。
 */
export interface EmbeddedAsset {
  type: string;
  body: ArrayBuffer;
}

export const EMBEDDED_ASSETS = new Map<string, EmbeddedAsset>();
