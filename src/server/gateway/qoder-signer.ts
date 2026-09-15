/**
 * Qoder 推理签名器：进程内跑那份 wasm-bindgen 产物,替每次推理请求算出原生签名。
 *
 * qoder-route 把它做成一个单独的 Node 子进程(signer_server.mjs,监听 8123),因为它的主体
 * 是 Python。本程序自己就是 Node,没有理由再拉一个子进程、占一个端口、管一套存活——直接把
 * 那段 wasm-bindgen 胶水移到这里,同进程调用即可。契约与 signer_server.mjs 完全一致:
 *
 *   prepareInfer(...)  → { url, headers, body }   对应 signer 的 POST /infer
 *   decrypt(payload)   → string | null            对应 signer 的 POST /decrypt
 *
 * 胶水本身是 wasm-bindgen 的标准运行时:一个手写的对象堆(heap)、一套按返回值个数读栈指针的
 * 调用约定,以及若干 __wbg_* 宿主导入。名字里那串十六进制是 wasm-bindgen 按符号哈希生成的,
 * 换一版 WASM 会变;换签名器时这份胶水要跟着对齐(见 signer_server.mjs 的注释)。
 */
import { QODER_WASM_BYTES } from './qoder-wasm-blob.js';

/** wasm-bindgen 兜底版本;真正的版本每次调用都由外部传进来(见 qoder.ts 解析 npm)。 */
const DEFAULT_COSY_VERSION = '1.1.36';

/**
 * 签名上下文里的客户端身份。数字 client_type 是路由判别位——这里写 "cli" 会把较新的
 * 目录模型留在旧的上游节点上,所以必须原样保留 qodercli 的取值。
 */
const CLIENT_META = JSON.stringify({
  client_type: '5',
  business_product: 'cli',
  business_type: 'agent',
  scene: 'assistant',
});

/** 上下文缓存上限:一个上下文对应一份(jt, machine_id, version),按 LRU 淘汰。 */
const MAX_CONTEXTS = 128;

export interface SignedInfer {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** WASM 导出的最小子集;字段名与 wasm-bindgen 生成的一致。 */
interface WasmExports {
  memory: WebAssembly.Memory;
  __wbindgen_add_to_stack_pointer(n: number): number;
  __wbindgen_export2(size: number, align: number): number;
  __wbindgen_export4(ptr: number, len: number, align: number): void;
  generate_runtime_auth_fields(sp: number, ...args: number[]): void;
  decrypt_server_response(sp: number, ...args: number[]): void;
  qodercontext_new(sp: number, ...args: number[]): void;
  qodercontext_prepareInferRequest(sp: number, ...args: number[]): void;
  requestresult_url(sp: number, rr: number): void;
  requestresult_headers(rr: number): number;
  requestresult_body(sp: number, rr: number): void;
  __wbg_requestresult_free(rr: number, drop: number): void;
  __wbg_qodercontext_free(ptr: number, drop: number): void;
  [key: string]: unknown;
}

/**
 * 一份加载好的签名器。整个进程只需要一份,懒加载(见文件底部的 signer())。
 *
 * 不是无状态的:WASM 线性内存、对象堆、以及按 (jt,machine,version) 建的上下文缓存都攒在
 * 这个实例里。Rust 把每个返回的 String / Vec<u8> 的所有权交给 JS,所以每读一次都要 free 一次,
 * 否则线性内存只增不减,迟早撞上 4GB 上限。
 */
class QoderSigner {
  private readonly wasm: WasmExports;
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();
  private readonly heap: unknown[] = new Array(128).fill(undefined);
  private heapNext: number;
  private globalLen = 0;
  /** cacheKey → { ptr, uid } */
  private readonly contexts = new Map<string, { ptr: number; uid: string }>();

  constructor(bytes: Uint8Array) {
    this.heap.push(undefined, null, true, false);
    this.heapNext = this.heap.length;
    const glue = this.buildGlue();
    // 同步实例化:290KB 的模块编译一下即可,省得把整条调用链染成 async
    const module = new WebAssembly.Module(bytes as unknown as BufferSource);
    const instance = new WebAssembly.Instance(module, { './qoder_auth_wasm_bg.js': glue as WebAssembly.ModuleImports });
    this.wasm = instance.exports as unknown as WasmExports;
  }

  // ---- 对象堆:wasm-bindgen 用它在 JS 侧存放非数字的宿主对象 ----

  private getObject(i: number): unknown {
    return this.heap[i];
  }

  private addHeapObject(o: unknown): number {
    if (this.heapNext === this.heap.length) this.heap.push(this.heap.length + 1);
    const idx = this.heapNext;
    this.heapNext = this.heap[idx] as number;
    this.heap[idx] = o;
    return idx;
  }

  private dropObject(i: number): void {
    if (i < 132) return;
    this.heap[i] = this.heapNext;
    this.heapNext = i;
  }

  // ---- 线性内存读写 ----

  private mem(): Uint8Array {
    return new Uint8Array(this.wasm.memory.buffer);
  }

  private view(): DataView {
    return new DataView(this.wasm.memory.buffer);
  }

  private getStr(p: number, l: number): string {
    return this.dec.decode(this.mem().subarray(p, p + l));
  }

  /** 把字符串写进 WASM 内存,长度暂存在 globalLen(wasm-bindgen 的两值返回约定)。 */
  private passString(s: string): number {
    const bytes = this.enc.encode(s);
    const ptr = this.wasm.__wbindgen_export2(bytes.length, 1);
    this.mem().set(bytes, ptr);
    this.globalLen = bytes.length;
    return ptr;
  }

  private addStack(n: number): number {
    return this.wasm.__wbindgen_add_to_stack_pointer(n);
  }

  /** Rust 交回来的 String / Vec<u8> 用完必须释放,否则线性内存只涨不落。 */
  private wasmFree(ptr: number, len: number): void {
    if (len) this.wasm.__wbindgen_export4(ptr, len, 1);
  }

  /** Result 的 Err 也是一个堆句柄:取下来、丢掉、还原成真正的错误信息。 */
  private takeError(idx: number): Error {
    const err = this.getObject(idx);
    this.dropObject(idx);
    if (err instanceof Error) return err;
    return new Error(typeof err === 'string' && err ? err : 'wasm 调用失败');
  }

  /**
   * 一批宿主导入。名字里的十六进制由 wasm-bindgen 按符号哈希生成,和这版 WASM 绑定;
   * 用 Proxy 兜底是为了让未列出的导入不至于让实例化直接失败(返回空对象句柄)。
   */
  private buildGlue(): Record<string, unknown> {
    return new Proxy(
      {},
      {
        get: (_t, prop): unknown => {
          const name = String(prop);
          if (name === '__wbindgen_object_drop_ref') return (i: number) => this.dropObject(i);
          if (name === '__wbindgen_object_clone_ref') return (i: number) => this.addHeapObject(this.getObject(i));
          if (name.startsWith('__wbindgen_cast_')) {
            return (a: number, b: number) =>
              typeof a === 'number' && typeof b === 'number' ? this.addHeapObject(this.getStr(a, b)) : a;
          }
          if (name === '__wbg_crypto_38df2bab126b63dc') return () => this.addHeapObject(globalThis.crypto);
          if (name === '__wbg_getRandomValues_d49329ff89a07af1') {
            return (a: number, b: number) => globalThis.crypto.getRandomValues(new Uint8Array(this.wasm.memory.buffer, a, b));
          }
          if (name === '__wbg_getRandomValues_c44a50d8cfdaebeb') {
            return (c: number, a: number) => (this.getObject(c) as Crypto).getRandomValues(this.getObject(a) as Uint8Array);
          }
          if (name === '__wbg_now_88621c9c9a4f3ffc') return () => Date.now();
          if (name.startsWith('__wbg_static_accessor_GLOBAL_THIS')) return () => this.addHeapObject(globalThis);
          if (name.startsWith('__wbg_static_accessor_SELF')) return () => this.addHeapObject(globalThis);
          if (name.startsWith('__wbg_static_accessor_GLOBAL')) return () => this.addHeapObject(globalThis);
          if (name.startsWith('__wbg_static_accessor_WINDOW')) return () => 0;
          if (name.startsWith('__wbg___wbindgen_throw')) {
            return (a: number, b: number) => {
              throw new Error(this.getStr(a, b));
            };
          }
          if (name.includes('__wbindgen_is_undefined')) return (i: number) => this.getObject(i) === undefined;
          if (name.includes('__wbindgen_is_object')) {
            return (i: number) => {
              const v = this.getObject(i);
              return typeof v === 'object' && v !== null;
            };
          }
          if (name.includes('__wbindgen_is_string')) return (i: number) => typeof this.getObject(i) === 'string';
          if (name.includes('__wbindgen_is_function')) return (i: number) => typeof this.getObject(i) === 'function';
          if (name === '__wbg_new_with_length_9cedd08484b73942') return (len: number) => this.addHeapObject(new Uint8Array(len));
          if (name === '__wbg_length_0c32cb8543c8e4c8') return (i: number) => (this.getObject(i) as Uint8Array).length;
          if (name === '__wbg_new_99cabae501c0a8a0') return () => this.addHeapObject(new Map());
          if (name === '__wbg_Error_2e59b1b37a9a34c3') return (a: number, b: number) => this.addHeapObject(new Error(this.getStr(a, b)));
          if (name === '__wbg_set_08463b1df38a7e29') {
            return (m: number, k: number, v: number) =>
              this.addHeapObject((this.getObject(m) as Map<unknown, unknown>).set(this.getObject(k), this.getObject(v)));
          }
          if (name === '__wbg_prototypesetcall_3e05eb9545565046') {
            return (h: number, d: number, l: number) => new Uint8Array(this.wasm.memory.buffer, h, d).set(this.getObject(l) as Uint8Array);
          }
          if (name === '__wbg_subarray_0f98d3fb634508ad') {
            return (i: number, a: number, b: number) => this.addHeapObject((this.getObject(i) as Uint8Array).subarray(a, b));
          }
          if (name === '__wbg_call_d578befcc3145dee') {
            return (fref: number, arg: number) => (this.getObject(fref) as (x: unknown) => unknown)(this.getObject(arg));
          }
          if (name === '__wbg_process_44c7a14e11e9f69e') return () => this.addHeapObject(process);
          if (name === '__wbg_versions_276b2795b1c6a219') return () => this.addHeapObject(process.versions);
          if (name === '__wbg_node_84ea875411254db1') return () => this.addHeapObject(process.versions.node);
          if (name === '__wbg_require_b4edbdcf3e2a1ef0') return () => 0;
          if (name === '__wbg_msCrypto_bd5a034af96bcba6') return () => 0;
          return () => this.addHeapObject({});
        },
      },
    ) as unknown as Record<string, unknown>;
  }

  /** 只返回一个字符串的 Rust 函数(Result<String, JsValue>),按四值返回约定读栈。 */
  private stackStringCall(fn: (sp: number, ...args: number[]) => void, args: string[]): string {
    const sp = this.addStack(-16);
    const ptrs: number[] = [];
    for (const a of args) {
      const p = this.passString(a);
      ptrs.push(p, this.globalLen);
    }
    fn(sp, ...ptrs);
    const r0 = this.view().getInt32(sp + 0, true);
    const r1 = this.view().getInt32(sp + 4, true);
    const r2 = this.view().getInt32(sp + 8, true);
    const r3 = this.view().getInt32(sp + 12, true);
    this.addStack(16);
    if (r3) throw this.takeError(r2);
    const s = this.getStr(r0, r1);
    this.wasmFree(r0, r1);
    return s;
  }

  private generateRuntimeAuthFields(subsetJson: string): Record<string, unknown> {
    return JSON.parse(this.stackStringCall(this.wasm.generate_runtime_auth_fields, [subsetJson]));
  }

  private newContext(machineId: string, cosyVersion: string, userInfoJson: string, clientMetaJson: string): number {
    const sp = this.addStack(-16);
    const a = this.passString(machineId), al = this.globalLen;
    const b = this.passString(cosyVersion), bl = this.globalLen;
    const c = this.passString(userInfoJson), cl = this.globalLen;
    const d = this.passString(clientMetaJson), dl = this.globalLen;
    this.wasm.qodercontext_new(sp, a, al, b, bl, c, cl, d, dl);
    const r0 = this.view().getInt32(sp + 0, true);
    const r1 = this.view().getInt32(sp + 4, true);
    const r2 = this.view().getInt32(sp + 8, true);
    this.addStack(16);
    if (r2) throw this.takeError(r1);
    return r0 >>> 0;
  }

  private prepareInferRequest(ctxPtr: number, baseUrl: string, bodyJson: string, modelKey: string, modelSource: string): number {
    const sp = this.addStack(-16);
    const a = this.passString(baseUrl), al = this.globalLen;
    const b = this.passString(bodyJson), bl = this.globalLen;
    const c = this.passString(modelKey), cl = this.globalLen;
    const d = this.passString(modelSource), dl = this.globalLen;
    this.wasm.qodercontext_prepareInferRequest(sp, ctxPtr, a, al, b, bl, c, cl, d, dl);
    const r0 = this.view().getInt32(sp + 0, true);
    const r1 = this.view().getInt32(sp + 4, true);
    const r2 = this.view().getInt32(sp + 8, true);
    this.addStack(16);
    if (r2) throw this.takeError(r1);
    return r0 >>> 0;
  }

  private resultUrl(rr: number): string {
    const sp = this.addStack(-16);
    this.wasm.requestresult_url(sp, rr);
    const p = this.view().getInt32(sp + 0, true);
    const l = this.view().getInt32(sp + 4, true);
    const s = this.getStr(p, l);
    this.addStack(16);
    this.wasmFree(p, l);
    return s;
  }

  private resultHeaders(rr: number): Record<string, string> {
    // getter 每次返回一个新的堆句柄(wasm-bindgen 的 take 语义),取下来后要丢掉
    const idx = this.wasm.requestresult_headers(rr);
    const m = this.getObject(idx);
    this.dropObject(idx);
    const out: Record<string, string> = {};
    if (m instanceof Map) for (const [k, v] of m) out[String(k)] = String(v);
    else if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) out[k] = String(v);
    return out;
  }

  private resultBody(rr: number): Buffer {
    const sp = this.addStack(-16);
    this.wasm.requestresult_body(sp, rr);
    const p = this.view().getInt32(sp + 0, true);
    const l = this.view().getInt32(sp + 4, true);
    const bytes = this.mem().slice(p, p + l);
    this.addStack(16);
    this.wasmFree(p, l);
    return Buffer.from(bytes);
  }

  private normalizeCosyVersion(value: string): string {
    const trimmed = (value ?? '').trim();
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : DEFAULT_COSY_VERSION;
  }

  private freeContext(ptr: number): void {
    if (ptr) this.wasm.__wbg_qodercontext_free(ptr, 0);
  }

  /**
   * 取(或建)一个签名上下文,按 (jt, machine, version) 缓存。
   *
   * qoder-route 的注释在此照录:Qoder CLI 交给 QoderContext 的是 getUserInfoForAuth() 的结果,
   * 不是登录/job token 记录本身。把 token 塞进这份 JSON 会改变生成出来的推理凭证,可能把较新的
   * 模型路由到旧的 provider 节点上。
   */
  private getContext(jt: string, uid: string, machineId: string, cosyVersion: string): number {
    const version = this.normalizeCosyVersion(cosyVersion);
    const cacheKey = `${jt}\0${machineId}\0${version}`;
    const cached = this.contexts.get(cacheKey);
    if (cached && cached.uid === uid) {
      // 刷新插入顺序,让 Map 兼作小型 LRU
      this.contexts.delete(cacheKey);
      this.contexts.set(cacheKey, cached);
      return cached.ptr;
    }
    if (cached) {
      this.contexts.delete(cacheKey);
      this.freeContext(cached.ptr);
    }
    const runtimeIdentity = { uid, organization_tags: [] as string[], data_policy_agreed: true };
    const raf = this.generateRuntimeAuthFields(JSON.stringify(runtimeIdentity));
    const userInfo = JSON.stringify({
      ...runtimeIdentity,
      encrypt_user_info: (raf.encrypt_user_info as string) || '',
      key: (raf.key as string) || '',
    });
    const ptr = this.newContext(machineId, version, userInfo, CLIENT_META);
    while (this.contexts.size >= MAX_CONTEXTS) {
      const oldestKey = this.contexts.keys().next().value as string;
      const oldest = this.contexts.get(oldestKey);
      this.contexts.delete(oldestKey);
      if (oldest) this.freeContext(oldest.ptr);
    }
    this.contexts.set(cacheKey, { ptr, uid });
    return ptr;
  }

  /** 对应 signer 的 POST /infer:算出签名后的 URL、请求头和请求体。 */
  prepareInfer(params: {
    jt: string;
    uid: string;
    machineId: string;
    baseUrl: string;
    bodyJson: string;
    modelKey: string;
    modelSource?: string;
    cosyVersion?: string;
  }): SignedInfer {
    const ctx = this.getContext(params.jt, params.uid, params.machineId, params.cosyVersion ?? DEFAULT_COSY_VERSION);
    const rr = this.prepareInferRequest(ctx, params.baseUrl, params.bodyJson, params.modelKey, params.modelSource ?? 'system');
    try {
      return { url: this.resultUrl(rr), headers: this.resultHeaders(rr), body: this.resultBody(rr) };
    } finally {
      this.wasm.__wbg_requestresult_free(rr, 0);
    }
  }

  /** 对应 signer 的 POST /decrypt:解密一条加密的 SSE 载荷;解不出来返回 null。 */
  decrypt(payload: string): string | null {
    try {
      return this.stackStringCall(this.wasm.decrypt_server_response, [payload]);
    } catch {
      return null;
    }
  }
}

let instance: QoderSigner | null = null;

/**
 * 进程内唯一的签名器。第一次调用时才实例化——没启用 Qoder 转发的部署不必为此加载 290KB WASM,
 * 也不必在启动时多花那一下编译。
 */
export function signer(): QoderSigner {
  if (!instance) instance = new QoderSigner(QODER_WASM_BYTES);
  return instance;
}

export type { QoderSigner };
