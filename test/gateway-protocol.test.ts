import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { collect, event, toMessageResponse, type EventStream } from '../src/server/gateway/anthropic.js';
import { fromOpenAi, toChatCompletion, toChatStream } from '../src/server/gateway/openai.js';
import { fromCodexStream, toCodexRequest } from '../src/server/gateway/codex.js';
import { parseSse, sseFrame } from '../src/server/gateway/sse.js';

type Json = Record<string, unknown>;

/** 把一串事件包成异步流，好喂给那些只认流的转换器。 */
async function* stream(...events: ReturnType<typeof event>[]): EventStream {
  for (const e of events) yield e;
}

/** 收集生成器吐出的全部分片。 */
async function drain(frames: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

/** OpenAI 流里每一片的 JSON；跳过 [DONE]。 */
function chunks(frames: string[]): Json[] {
  return frames
    .map((f) => f.replace(/^data: /, '').trim())
    .filter((d) => d !== '' && d !== '[DONE]')
    .map((d) => JSON.parse(d) as Json);
}

/* ---------- SSE ---------- */

test('SSE 解析认 \\r\\n，也不丢末尾没有空行的最后一帧', async () => {
  // 真实链路上到手的是字节，不是字符串；测试也照这个来，免得掩盖解码那一段
  const raw = Readable.from(
    [
      'event: a\r\ndata: {"n":1}\r\n\r\n',
      'event: b\ndata: {"n":2}\n\n',
      'event: c\ndata: {"n":3}',
    ].map((f) => Buffer.from(f)),
  );
  const got = [];
  for await (const evt of parseSse(raw)) got.push(evt);
  assert.deepEqual(got, [
    { event: 'a', data: '{"n":1}' },
    { event: 'b', data: '{"n":2}' },
    { event: 'c', data: '{"n":3}' },
  ]);
});

test('一帧被切在两个 chunk 中间时照样拼得回来', async () => {
  const raw = Readable.from(['event: a\ndata: {"te', 'xt":"你好"}\n\nevent: b\ndata: {}\n\n'].map((f) => Buffer.from(f)));
  const got = [];
  for await (const evt of parseSse(raw)) got.push(evt);
  assert.deepEqual(got[0], { event: 'a', data: '{"text":"你好"}' });
  assert.equal(got.length, 2);
});

/* ---------- OpenAI 请求 → IR ---------- */

test('system 和 developer 消息收进顶层 system 字段', () => {
  const req = fromOpenAi({
    model: 'gpt-5',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'developer', content: '只说中文' },
      { role: 'user', content: '在吗' },
    ],
  });
  assert.equal(req.system, '你是助手\n\n只说中文');
  assert.equal(req.messages.length, 1, 'system 不该留在 messages 里');
  assert.equal(req.messages[0].role, 'user');
});

test('相邻同角色消息并成一条：Anthropic 要求严格交替', () => {
  const req = fromOpenAi({
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '好的' },
    ],
  });
  assert.equal(req.messages.length, 2);
  assert.deepEqual(req.messages[0].content, [
    { type: 'text', text: '第一句' },
    { type: 'text', text: '第二句' },
  ]);
});

test('工具调用与工具结果翻成 tool_use / tool_result 块', () => {
  const req = fromOpenAi({
    model: 'gpt-5',
    messages: [
      { role: 'user', content: '天气' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '晴' },
    ],
  });
  const assistant = req.messages[1].content as Json[];
  assert.deepEqual(assistant[0], { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: '北京' } });
  // 工具结果在 Anthropic 那边属于 user 消息
  assert.equal(req.messages[2].role, 'user');
  assert.deepEqual(req.messages[2].content, [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }]);
});

test('工具参数不是合法 JSON 时留原文，不把整条请求弄崩', () => {
  const req = fromOpenAi({
    model: 'gpt-5',
    messages: [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{坏的' } }] },
    ],
  });
  const block = (req.messages[0].content as Json[])[0];
  assert.deepEqual(block.input, { _raw: '{坏的' });
});

test('max_tokens 缺省时补一个，因为 Anthropic 这个字段是必填的', () => {
  assert.equal(fromOpenAi({ model: 'x', messages: [] }).max_tokens, 8192);
  assert.equal(fromOpenAi({ model: 'x', messages: [], max_tokens: 100 }).max_tokens, 100);
  assert.equal(
    fromOpenAi({ model: 'x', messages: [], max_completion_tokens: 256 }).max_tokens,
    256,
    '新字段名也要认',
  );
});

test('tools 与 tool_choice 按形状翻译', () => {
  const req = fromOpenAi({
    model: 'x',
    messages: [],
    tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
    tool_choice: 'required',
  });
  assert.deepEqual(req.tools, [{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
  assert.deepEqual(req.tool_choice, { type: 'any' });
  assert.deepEqual(fromOpenAi({ model: 'x', messages: [], tool_choice: 'none' }).tool_choice, { type: 'none' });
  assert.deepEqual(
    fromOpenAi({ model: 'x', messages: [], tool_choice: { type: 'function', function: { name: 'f' } } }).tool_choice,
    { type: 'tool', name: 'f' },
  );
});

test('data URL 图片拆成 base64 源，普通 URL 原样给上游', () => {
  const req = fromOpenAi({
    model: 'x',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      },
    ],
  });
  assert.deepEqual(req.messages[0].content, [
    { type: 'text', text: '看图' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
  ]);
});

/* ---------- IR 事件流 → 聚合 / OpenAI ---------- */

const START = event('message_start', {
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [],
    usage: { input_tokens: 11, output_tokens: 0 },
  },
});

test('聚合把分片的文本、思考和工具参数拼回完整的块', async () => {
  const result = await collect(
    stream(
      START,
      event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '先想' } }),
      event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '一下' } }),
      event('content_block_stop', { index: 0 }),
      event('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '答' } }),
      event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '案' } }),
      event('content_block_stop', { index: 1 }),
      event('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 't1', name: 'f', input: {} } }),
      event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":' } }),
      event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '1}' } }),
      event('content_block_stop', { index: 2 }),
      event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
      event('message_stop', {}),
    ),
  );
  assert.equal(result.id, 'msg_1');
  assert.equal(result.model, 'claude-sonnet-5');
  assert.equal(result.content[0].thinking, '先想一下');
  assert.equal(result.content[1].text, '答案');
  assert.deepEqual(result.content[2].input, { a: 1 }, '流过来的 JSON 片段要拼完再解析');
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.inputTokens, 11, 'usage 分散在两个事件里，两处都要收');
  assert.equal(result.outputTokens, 7);
});

test('上游推来 error 事件时聚合直接失败，不返回半条回复', async () => {
  await assert.rejects(
    () => collect(stream(START, event('error', { error: { type: 'overloaded_error', message: '过载了' } }))),
    /过载了/,
  );
});

test('聚合结果能还原成一条标准的 Messages 响应', async () => {
  const result = await collect(
    stream(
      START,
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好' } }),
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
    ),
  );
  const body = toMessageResponse(result, 'claude-sonnet-5') as Json;
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.deepEqual(body.content, [{ type: 'text', text: '你好' }]);
  assert.deepEqual(body.usage, { input_tokens: 11, output_tokens: 3 });
});

test('非流式的 OpenAI 响应带 tool_calls，思考走 reasoning_content', async () => {
  const result = await collect(
    stream(
      START,
      event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '想了想' } }),
      event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 't1', name: 'f', input: {} } }),
      event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
    ),
  );
  const body = toChatCompletion(result, 'gpt-5', 'chatcmpl-1') as Json;
  const choice = (body.choices as Json[])[0];
  const message = choice.message as Json;
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(message.content, null, '只有工具调用时 content 该是 null');
  assert.equal(message.reasoning_content, '想了想');
  assert.deepEqual(message.tool_calls, [
    { index: 0, id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } },
  ]);
  assert.deepEqual(body.usage, { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
});

test('OpenAI 流：先发 role，再发内容，最后 finish 和 [DONE]', async () => {
  const frames = await drain(
    toChatStream(
      stream(
        START,
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '嗨' } }),
        event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 4, output_tokens: 2 } }),
      ),
      'gpt-5',
      'chatcmpl-1',
    ),
  );
  assert.equal(frames.at(-1), sseFrame('', '[DONE]'));
  const parsed = chunks(frames);
  assert.deepEqual((parsed[0].choices as Json[])[0].delta, { role: 'assistant' });
  assert.equal(((parsed[1].choices as Json[])[0].delta as Json).content, '嗨');
  const finish = parsed.find((p) => ((p.choices as Json[])[0] ?? {}).finish_reason === 'stop');
  assert.ok(finish, '没有 finish 分片的话，客户端不知道该收尾了');
  assert.deepEqual(parsed.at(-1)!.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

test('OpenAI 流里的工具调用按自己的 index 归位，不跟着上游的块下标走', async () => {
  const frames = await drain(
    toChatStream(
      stream(
        START,
        // 上游的第 0 块是思考，不该占掉 tool_call 的槽位
        event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
        event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'a', name: 'f1', input: {} } }),
        event('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'b', name: 'f2', input: {} } }),
        event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } }),
        event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"y":2}' } }),
        event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }),
      ),
      'gpt-5',
      'chatcmpl-1',
    ),
  );
  const calls = chunks(frames)
    .flatMap((p) => (((p.choices as Json[])?.[0]?.delta as Json)?.tool_calls as Json[]) ?? []);
  assert.deepEqual(
    calls.map((c) => [c.index, (c.function as Json).name ?? '', (c.function as Json).arguments]),
    [
      [0, 'f1', ''],
      [1, 'f2', ''],
      [1, '', '{"x":1}'],
      [0, '', '{"y":2}'],
    ],
    '参数片段乱序到达也要落回自己那一格',
  );
});

test('流中途报错让 toChatStream 抛出，交给上层发错误帧', async () => {
  await assert.rejects(
    () => drain(toChatStream(stream(START, event('error', { error: { message: '断了' } })), 'gpt-5', 'id')),
    /断了/,
  );
});

/* ---------- IR ⇄ Codex Responses ---------- */

test('Codex 请求：system 变 instructions，工具调用摊平成 item', () => {
  const body = toCodexRequest(
    {
      model: 'gpt-5-codex',
      system: '你是助手',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: '算一下' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '内部想法', signature: 'sig' },
            { type: 'text', text: '这就算' },
            { type: 'tool_use', id: 'call_1', name: 'calc', input: { a: 1 } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '2' }] },
      ],
      tools: [{ name: 'calc', description: '算', input_schema: { type: 'object' } }],
    },
    'gpt-5-codex',
  ) as Json;

  assert.equal(body.instructions, '你是助手');
  assert.equal(body.stream, true, '这个端点只接受流式');
  assert.equal(body.store, false, '不把用户的对话存在账户名下');
  assert.equal(body.max_output_tokens, undefined, '这个端点不认 max_output_tokens，带上去整条请求就 400');

  const input = body.input as Json[];
  assert.deepEqual(input.map((i) => i.type), ['message', 'message', 'function_call', 'function_call_output']);
  // 思考块不回传：签名只对签发它的那家上游有意义
  const assistantParts = (input[1].content as Json[]).map((p) => p.type);
  assert.deepEqual(assistantParts, ['output_text']);
  assert.equal((input[2] as Json).call_id, 'call_1');
  assert.equal((input[3] as Json).output, '2');
  assert.deepEqual((body.tools as Json[])[0].name, 'calc');
});

test('思考预算折算成 Responses 的三档 effort', () => {
  const base = { model: 'm', messages: [] };
  const effort = (thinking?: Json): string =>
    ((toCodexRequest({ ...base, thinking }, 'm').reasoning as Json).effort as string);
  assert.equal(effort(), 'medium', '没要求思考时用默认档');
  assert.equal(effort({ type: 'enabled', budget_tokens: 20000 }), 'high');
  assert.equal(effort({ type: 'enabled', budget_tokens: 1000 }), 'low');
  assert.equal(effort({ type: 'enabled', budget_tokens: 8000 }), 'medium');
});

/** 把 Responses 的事件拼成一段 SSE 字节流。 */
function codexStream(...events: Json[]): Readable {
  return Readable.from(events.map((e) => Buffer.from(sseFrame(String(e.type), JSON.stringify(e)))));
}

test('Codex 流翻成 Anthropic 事件，块下标由我们自己发号', async () => {
  const got = [];
  for await (const evt of fromCodexStream(
    codexStream(
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5-codex' } },
      // Responses 把 reasoning 和 message 排在同一个 output_index 序列里
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '想一下' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message' } },
      { type: 'response.output_text.delta', output_index: 1, delta: '结果是 2' },
      { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 4 } } },
    ),
    'gpt-5-codex',
  )) {
    got.push(JSON.parse(evt.data) as Json);
  }

  assert.equal(got[0].type, 'message_start');
  assert.equal(((got[0].message as Json).model as string), 'gpt-5-codex');
  const starts = got.filter((g) => g.type === 'content_block_start');
  assert.deepEqual(
    starts.map((s) => [s.index, (s.content_block as Json).type]),
    [
      [0, 'thinking'],
      [1, 'text'],
    ],
    '下标要连续，中间不能留空洞',
  );
  const deltas = got.filter((g) => g.type === 'content_block_delta');
  assert.equal((deltas[0].delta as Json).thinking, '想一下');
  assert.equal((deltas[1].delta as Json).text, '结果是 2');
  // 没有 content_block_stop 的话，客户端会一直等着这个块结束
  assert.equal(got.filter((g) => g.type === 'content_block_stop').length, 2);
  const last = got.at(-1)!;
  assert.equal(last.type, 'message_stop');
  const usage = got.find((g) => g.type === 'message_delta')!.usage as Json;
  assert.deepEqual(usage, { input_tokens: 9, output_tokens: 4 });
});

test('上游先推 item 再补 response.created 时也要有 message_start 打头', async () => {
  const got = [];
  for await (const evt of fromCodexStream(
    codexStream(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '嗨' },
      { type: 'response.completed', response: {} },
    ),
    'gpt-5-codex',
  )) {
    got.push(JSON.parse(evt.data) as Json);
  }
  assert.equal(got[0].type, 'message_start', '缺了它客户端无法开始');
  assert.equal(((got[0].message as Json).model as string), 'gpt-5-codex', '认不出型号就用请求里那个');
});

test('Codex 的函数调用翻成 tool_use 块，参数片段跟着走', async () => {
  const result = await collect(
    fromCodexStream(
      codexStream(
        { type: 'response.created', response: { id: 'r', model: 'gpt-5-codex' } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_9', name: 'calc' },
        },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":' },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '3}' },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ),
      'gpt-5-codex',
    ),
  );
  assert.equal(result.content[0].type, 'tool_use');
  assert.equal(result.content[0].id, 'call_9');
  assert.equal(result.content[0].name, 'calc');
  assert.deepEqual(result.content[0].input, { a: 3 });
});

test('OpenAI 请求经 IR 转成 Codex 请求：一整条链路对得上', () => {
  const ir = fromOpenAi({
    model: 'gpt-5',
    messages: [
      { role: 'system', content: '简短回答' },
      { role: 'user', content: '1+1' },
    ],
    temperature: 0.2,
  });
  const body = toCodexRequest(ir, 'gpt-5-codex') as Json;
  assert.equal(body.model, 'gpt-5-codex', '发给上游的是解析后的模型名');
  assert.equal(body.instructions, '简短回答');
  assert.equal(body.temperature, undefined, 'temperature 同理：上游只认 Codex CLI 用得上的那几个字段');
  assert.deepEqual((body.input as Json[])[0], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '1+1' }],
  });
});
