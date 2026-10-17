type Scope = 'event' | 'part' | 'other';
type Phase = 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd';
type Frame = { kind: 'object' | 'array'; scope: Scope; phase: Phase; key: string };
type StringToken = { target: 'key' | 'type' | 'text' | 'other'; value: string; escape: boolean; unicode: string | null; highSurrogate: string | null };

export interface TextEventCheckpoint {
  readonly frames: readonly Frame[];
  readonly token: StringToken | null;
  readonly primitive: string;
  readonly done: boolean;
  readonly invalid: boolean;
  readonly started: boolean;
  readonly type: string;
  readonly text: string;
  readonly textBytes: number;
  readonly textTruncated: boolean;
  readonly skipping: boolean;
  readonly partial: boolean;
}

export const TASK_TEXT_PREVIEW_LIMIT = 64 * 1024;
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function initial(skipping = false): TextEventCheckpoint {
  return { frames: [], token: null, primitive: '', done: false, invalid: false, started: false, type: '', text: '', textBytes: 0, textTruncated: false, skipping, partial: skipping };
}

function utf8Length(value: string): number {
  const codePoint = value.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 3;
  return codePoint <= 0xffff ? 3 : 4;
}

export function projectTextEvents(input: string, options: {
  readonly checkpoint?: TextEventCheckpoint;
  readonly partialStart?: boolean;
  readonly final?: boolean;
} = {}) {
  const seed = options.checkpoint ?? initial(options.partialStart);
  const frames = seed.frames.map((frame) => ({ ...frame }));
  let token = seed.token === null ? null : { ...seed.token };
  let primitive = seed.primitive;
  let done = seed.done;
  let invalid = seed.invalid;
  let started = seed.started;
  let eventType = seed.type;
  let text = seed.text;
  let textBytes = seed.textBytes;
  let textTruncated = seed.textTruncated;
  let skipping = seed.skipping;
  let partial = seed.partial;
  let truncatedOutput = false;
  let invalidLines = 0;
  const output: string[] = [];

  const complete = () => {
    const frame = frames.at(-1);
    if (frame) frame.phase = 'commaOrEnd';
    else done = true;
  };
  const primitiveEnd = () => {
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(primitive)) invalid = true;
    primitive = '';
    complete();
  };
  const lineEnd = () => {
    if (primitive !== '') primitiveEnd();
    if (!skipping && started) {
      if (invalid || token !== null || frames.length !== 0 || !done) invalidLines = Math.min(999, invalidLines + 1);
      else if (eventType === 'text') {
        output.push(text);
        truncatedOutput ||= textTruncated;
      }
    }
    frames.length = 0;
    token = null;
    primitive = '';
    done = false;
    invalid = false;
    started = false;
    eventType = '';
    text = '';
    textBytes = 0;
    textTruncated = false;
    skipping = false;
  };
  const append = (character: string) => {
    if (token === null) return;
    switch (token.target) {
      case 'key': case 'type':
        token.value = (token.value + character).slice(0, 16);
        break;
      case 'text':
        if (!textTruncated) {
          const bytes = utf8Length(character);
          if (textBytes + bytes <= TASK_TEXT_PREVIEW_LIMIT) {
            text += character;
            textBytes += bytes;
          } else textTruncated = true;
        }
        break;
      case 'other': break;
      default: token.target satisfies never;
    }
  };
  const flushHighSurrogate = () => {
    if (token?.highSurrogate !== null && token?.highSurrogate !== undefined) {
      append(token.highSurrogate);
      token.highSurrogate = null;
    }
  };
  const stringCharacter = (character: string) => {
    if (token === null) return;
    if (token.unicode !== null) {
      if (!/^[0-9a-f]$/i.test(character)) { invalid = true; return; }
      token.unicode += character;
      if (token.unicode.length === 4) {
        const unit = Number.parseInt(token.unicode, 16);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          flushHighSurrogate();
          token.highSurrogate = String.fromCharCode(unit);
        } else if (unit >= 0xdc00 && unit <= 0xdfff && token.highSurrogate !== null) {
          append(token.highSurrogate + String.fromCharCode(unit));
          token.highSurrogate = null;
        } else {
          flushHighSurrogate();
          append(String.fromCharCode(unit));
        }
        token.unicode = null;
      }
    } else if (token.escape) {
      token.escape = false;
      if (character === 'u') token.unicode = '';
      else if (Object.hasOwn(ESCAPES, character)) {
        flushHighSurrogate();
        append(ESCAPES[character]);
      }
      else invalid = true;
    } else if (character === '\\') token.escape = true;
    else if (character === '"') {
      flushHighSurrogate();
      if (token.target === 'key') {
        const frame = frames.at(-1);
        if (frame) { frame.key = token.value; frame.phase = 'colon'; }
      } else {
        if (token.target === 'type') eventType = token.value;
        complete();
      }
      token = null;
    } else if (character.charCodeAt(0) < 32) invalid = true;
    else {
      flushHighSurrogate();
      append(character);
    }
  };

  for (const character of input) {
    if (character === '\n') { lineEnd(); continue; }
    if (skipping || invalid) continue;
    if (token !== null) { stringCharacter(character); continue; }
    if (primitive !== '') {
      if (!/[\s,}\]]/.test(character)) {
        primitive += character;
        if (primitive.length > 128) invalid = true;
        continue;
      }
      primitiveEnd();
      if (invalid) continue;
    }
    if (/^[\t\r ]$/.test(character)) continue;
    started = true;
    const frame = frames.at(-1);
    if (done) { invalid = true; continue; }
    if (character === '}' || character === ']') {
      if (!frame || (character === '}') !== (frame.kind === 'object')
        || !['keyOrEnd', 'valueOrEnd', 'commaOrEnd'].includes(frame.phase)) { invalid = true; continue; }
      frames.pop();
      complete();
      continue;
    }
    if (frame?.phase === 'commaOrEnd') {
      if (character !== ',') invalid = true;
      else frame.phase = frame.kind === 'object' ? 'key' : 'value';
      continue;
    }
    if (frame?.phase === 'colon') {
      if (character !== ':') invalid = true;
      else frame.phase = 'value';
      continue;
    }
    if (frame?.phase === 'keyOrEnd' || frame?.phase === 'key') {
      if (character !== '"') invalid = true;
        else token = { target: 'key', value: '', escape: false, unicode: null, highSurrogate: null };
      continue;
    }
    const scope: Scope = frames.length === 0 ? 'event'
      : frame?.scope === 'event' && frame.key === 'part' ? 'part' : 'other';
    if (frame?.scope === 'event' && frame.key === 'type') eventType = '';
    if ((frame?.scope === 'event' && frame.key === 'part') || (frame?.scope === 'part' && frame.key === 'text')) text = '';
    if (character === '{' || character === '[') {
      if (frames.length === 64) { invalid = true; continue; }
      frames.push({ kind: character === '{' ? 'object' : 'array', scope: character === '{' ? scope : 'other', phase: character === '{' ? 'keyOrEnd' : 'valueOrEnd', key: '' });
    } else if (character === '"') {
      const target = frame?.scope === 'event' && frame.key === 'type' ? 'type'
        : frame?.scope === 'part' && frame.key === 'text' ? 'text' : 'other';
      if (target === 'text') text = '';
      token = { target, value: '', escape: false, unicode: null, highSurrogate: null };
    } else if (/^[\dtfn-]$/.test(character)) primitive = character;
    else invalid = true;
  }
  if (options.final) lineEnd();
  const checkpoint: TextEventCheckpoint = { frames, token, primitive, done, invalid, started, type: eventType, text, textBytes, textTruncated, skipping, partial };
  return { text: output.join(''), invalidLines, partial, textTruncated: truncatedOutput, pending: started && !done, checkpoint };
}
