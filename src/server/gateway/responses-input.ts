import type { AnthropicMessage, AnthropicRequest, ContentBlock } from './anthropic.js';

const DEFAULT_MAX_TOKENS = 8192;

export class ResponsesInputError extends Error {
  readonly name = 'ResponsesInputError';

  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResponsesInputError(path, 'expected an object');
  }
  return { ...value };
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ResponsesInputError(path, 'expected a string');
  return value;
}

function fields(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ResponsesInputError(path ? `${path}.${key}` : key, 'unsupported field');
  }
}

function parts(value: unknown, path: string, role: string): ContentBlock[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) throw new ResponsesInputError(path, 'expected a string or content array');
  return value.map((raw, index): ContentBlock => {
    const at = `${path}[${index}]`;
    const part = object(raw, at);
    switch (part.type) {
      case 'input_text':
      case 'output_text':
        if (part.type === 'output_text' && role !== 'assistant') {
          throw new ResponsesInputError(`${at}.type`, 'output_text requires assistant role');
        }
        if (part.type === 'input_text' && role === 'assistant') {
          throw new ResponsesInputError(`${at}.type`, 'input_text is not assistant output');
        }
        fields(part, at, ['type', 'text']);
        return { type: 'text', text: text(part.text, `${at}.text`) };
      case 'input_image': {
        if (role !== 'user') throw new ResponsesInputError(`${at}.type`, 'input_image requires user role');
        fields(part, at, ['type', 'image_url']);
        const url = text(part.image_url, `${at}.image_url`);
        const match = /^data:([^;]+);base64,(.+)$/.exec(url);
        if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
        if (!/^https?:\/\//.test(url)) throw new ResponsesInputError(`${at}.image_url`, 'expected an image URL or base64 data URL');
        return { type: 'image', source: { type: 'url', url } };
      }
      default:
        throw new ResponsesInputError(`${at}.type`, 'unsupported content type');
    }
  });
}

function inputItems(input: unknown): { messages: AnthropicMessage[]; system: string[] } {
  const messages: AnthropicMessage[] = [];
  const system: string[] = [];
  if (typeof input === 'string') return { messages: [{ role: 'user', content: [{ type: 'text', text: input }] }], system };
  if (!Array.isArray(input)) throw new ResponsesInputError('input', 'expected a string or array');

  const push = (role: AnthropicMessage['role'], content: ContentBlock[]): void => {
    if (content.length === 0) return;
    const previous = messages.at(-1);
    if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...content);
    else messages.push({ role, content });
  };

  for (const [index, raw] of input.entries()) {
    const path = `input[${index}]`;
    const item = object(raw, path);
    if (item.type === undefined || item.type === 'message') {
      fields(item, path, ['type', 'role', 'content']);
      const role = item.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
        throw new ResponsesInputError(`${path}.role`, 'unsupported role');
      }
      const content = parts(item.content, `${path}.content`, role);
      if (role === 'system' || role === 'developer') {
        system.push(content.map((block) => text(block.text, `${path}.content`)).join(''));
      } else push(role, content);
      continue;
    }
    switch (item.type) {
      case 'function_call': {
        fields(item, path, ['type', 'call_id', 'name', 'arguments']);
        const args = text(item.arguments, `${path}.arguments`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(args);
        } catch {
          throw new ResponsesInputError(`${path}.arguments`, 'expected valid JSON');
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new ResponsesInputError(`${path}.arguments`, 'expected a JSON object');
        }
        push('assistant', [{ type: 'tool_use', id: text(item.call_id, `${path}.call_id`), name: text(item.name, `${path}.name`), input: parsed }]);
        break;
      }
      case 'function_call_output': {
        fields(item, path, ['type', 'call_id', 'output']);
        const output = item.output;
        let content: string | ContentBlock[];
        if (typeof output === 'string') content = output;
        else {
          const blocks = parts(output, `${path}.output`, 'user');
          if (blocks.some((block) => block.type !== 'text')) throw new ResponsesInputError(`${path}.output`, 'only text tool output is supported');
          content = blocks;
        }
        push('user', [{ type: 'tool_result', tool_use_id: text(item.call_id, `${path}.call_id`), content }]);
        break;
      }
      default:
        throw new ResponsesInputError(`${path}.type`, 'unsupported input item');
    }
  }
  return { messages, system };
}

function toolsOf(value: unknown): AnthropicRequest['tools'] {
  if (!Array.isArray(value)) throw new ResponsesInputError('tools', 'expected an array');
  return value.map((raw, index) => {
    const path = `tools[${index}]`;
    const tool = object(raw, path);
    if (tool.type !== 'function') throw new ResponsesInputError(`${path}.type`, 'unsupported tool type');
    fields(tool, path, ['type', 'name', 'description', 'parameters', 'strict']);
    if (tool.strict === true) throw new ResponsesInputError(`${path}.strict`, 'strict tool schema is not supported');
    if (tool.strict !== undefined && tool.strict !== false) throw new ResponsesInputError(`${path}.strict`, 'expected false');
    const name = text(tool.name, `${path}.name`);
    const description = tool.description === undefined ? undefined : text(tool.description, `${path}.description`);
    const schema = tool.parameters === undefined ? { type: 'object', properties: {} } : object(tool.parameters, `${path}.parameters`);
    return { name, ...(description === undefined ? {} : { description }), input_schema: schema };
  });
}

function choiceOf(value: unknown): AnthropicRequest['tool_choice'] {
  switch (value) {
    case 'auto': return { type: 'auto' };
    case 'none': return { type: 'none' };
    case 'required': return { type: 'any' };
    default: {
      const choice = object(value, 'tool_choice');
      fields(choice, 'tool_choice', ['type', 'name']);
      if (choice.type !== 'function') throw new ResponsesInputError('tool_choice.type', 'unsupported tool choice');
      return { type: 'tool', name: text(choice.name, 'tool_choice.name') };
    }
  }
}

function thinkingOf(value: unknown): AnthropicRequest['thinking'] {
  const reasoning = object(value, 'reasoning');
  fields(reasoning, 'reasoning', ['effort']);
  switch (reasoning.effort) {
    case 'low': return { type: 'enabled', budget_tokens: 1000 };
    case 'medium': return { type: 'enabled', budget_tokens: 8000 };
    case 'high': return { type: 'enabled', budget_tokens: 16000 };
    default: throw new ResponsesInputError('reasoning.effort', 'unsupported reasoning effort');
  }
}

export function parseResponsesRequest(raw: unknown): AnthropicRequest {
  const body = object(raw, 'request');
  fields(body, '', ['model', 'input', 'instructions', 'tools', 'tool_choice', 'max_output_tokens', 'reasoning', 'stream', 'store', 'background', 'previous_response_id', 'conversation']);
  for (const field of ['previous_response_id', 'conversation'] as const) {
    if (body[field] !== undefined && body[field] !== null) throw new ResponsesInputError(field, 'stateful requests are unsupported');
  }
  if (body.background !== undefined && body.background !== false) throw new ResponsesInputError('background', 'background requests are unsupported');
  if (body.store !== undefined && body.store !== false) throw new ResponsesInputError('store', 'stored requests are unsupported');

  const model = text(body.model, 'model');
  if (!model) throw new ResponsesInputError('model', 'expected a nonempty model');
  const { messages, system } = inputItems(body.input);
  if (body.instructions !== undefined) system.unshift(text(body.instructions, 'instructions'));
  const request: AnthropicRequest = { model, messages, max_tokens: DEFAULT_MAX_TOKENS, stream: false };
  if (system.length > 0) request.system = system.join('\n\n');
  if (body.max_output_tokens !== undefined) {
    if (typeof body.max_output_tokens !== 'number' || !Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0) {
      throw new ResponsesInputError('max_output_tokens', 'expected a positive integer');
    }
    request.max_tokens = body.max_output_tokens;
  }
  if (body.stream !== undefined) {
    if (typeof body.stream !== 'boolean') throw new ResponsesInputError('stream', 'expected a boolean');
    request.stream = body.stream;
  }
  if (body.tools !== undefined) request.tools = toolsOf(body.tools);
  if (body.tool_choice !== undefined) request.tool_choice = choiceOf(body.tool_choice);
  if (body.reasoning !== undefined) request.thinking = thinkingOf(body.reasoning);
  return request;
}
