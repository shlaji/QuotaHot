import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskModelField } from '../src/web/components/TaskModelField.js';

test('task model caption labels the height-bounded listbox trigger and shows the default model', () => {
  const html = renderToStaticMarkup(createElement(TaskModelField, {
    value: 'openai/gpt-6-luna-fast',
    discovery: {
      response: null,
      loading: false,
      error: '',
      refresh: () => {},
    },
    onChange: () => {},
  }));

  const label = html.match(/<label[^>]*for="([^"]+)"/);
  assert.ok(label, 'the model caption must use an activating HTML label');
  assert.ok(html.includes(`<button id="${label[1]}"`), 'the label must target the listbox trigger');
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /openai\/gpt-6-luna-fast/);
  assert.doesNotMatch(html, /<select/);
});
