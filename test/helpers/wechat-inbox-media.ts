import type { Page } from 'playwright-core';

export const attachmentIds = {
  image: '11111111-1111-4111-8111-111111111111',
  voice: '22222222-2222-4222-8222-222222222222',
  video: '33333333-3333-4333-8333-333333333333',
  file: '44444444-4444-4444-8444-444444444444',
} as const;
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const video = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAPnEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggPR7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECfQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYgljmhrTONbVJyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAX14QDgibCBoLqBWpqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYgljmhrTONbVGfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnVCLOeBAKO7gQAAgFAFAJ0BKqAAWgAARwiFhYiFhIgCAgAGKBJu/PXoy8Rz16MvEc9ejLxHPXoy8Rz16MvEZQD+aACjmIEAZAARAgAFEKwAGAAYWC/0AAiAgQAAAKOYgQDIABECAAUQrAAYABhYL/QACICBAAAAo5iBASwAEQIABRCsABgAGFgv9AAIgIEAAACjmIEBkAARAgAFEKwAGAAYWC/0AAiAgQAAAKOYgQH0ABECAAUQrAAYABhYL/QACICBAAAAo5iBAlgAEQIABRCsABgAGFgv9AAIgIEAAACjl4ECvADxAQAFEBAUYABhYL/QACICBAAAo5iBAyAAEQIABRCsABgAGFgv9AAIgIEAAACjmIEDhAARAgAFEKwAGAAYWC/0AAiAgQAAAKOYgQPoABECAAUQrAAYABhYL/QACICBAAAAo5iBBEwAEQIABRCsABgAGFgv9AAIgIEAAACjmIEEsAARAgAFEKwAGAAYWC/0AAiAgQAAAKOYgQUUABECAAUQrAAYABhYL/QACICBAAAAo5iBBXgAEQIABRCsABgAGFgv9AAIgIEAAACjmIEF3AARAgAFEKwAGAAYWC/0AAiAgQAAAKOYgQZAABECAAUQrAAYABhYL/QACICBAAAAo5iBBqQAEQIABRCsABgAGFgv9AAIgIEAAACjl4EHCADxAQAFEBAUYABhYL/QACICBAAAo5iBB2wAEQIABRCsABgAGFgv9AAIgIEAAAAcU7trkbuPs4EAt4r3gQHxggGf8IED', 'base64');
const voice = Buffer.alloc(44 + 16_000);
voice.write('RIFF', 0); voice.writeUInt32LE(voice.length - 8, 4); voice.write('WAVEfmt ', 8);
voice.writeUInt32LE(16, 16); voice.writeUInt16LE(1, 20); voice.writeUInt16LE(1, 22);
voice.writeUInt32LE(8_000, 24); voice.writeUInt32LE(16_000, 28); voice.writeUInt16LE(2, 32);
voice.writeUInt16LE(16, 34); voice.write('data', 36); voice.writeUInt32LE(16_000, 40);

export function mediaFixture(id: string) {
  switch (id) {
    case attachmentIds.voice: return { contentType: 'audio/wav', body: voice };
    case attachmentIds.video: return { contentType: 'video/webm', body: video };
    case attachmentIds.file: return { contentType: 'text/plain', body: Buffer.from('微信下载测试附件\n') };
    default: return { contentType: 'image/png', body: image };
  }
}

export async function waitForInboxMedia(page: Page) {
  await page.locator('.wechat-media img').evaluateAll(async (images) => Promise.all(images.map(async (image) => {
    if (!(image instanceof HTMLImageElement)) throw new Error('Expected image');
    image.loading = 'eager';
    await image.decode();
  })));
  await page.locator('audio, video').evaluateAll(async (elements) => Promise.all(elements.map(async (element) => {
    if (!(element instanceof HTMLMediaElement)) throw new Error('Expected native media');
    if (element.readyState >= 4) return;
    await new Promise<void>((resolve, reject) => {
      element.addEventListener('canplaythrough', () => resolve(), { once: true });
      element.addEventListener('error', () => reject(new Error('Media fixture decode failed')), { once: true });
      element.preload = 'auto';
      element.load();
    });
  })));
  await page.locator('video').evaluateAll(async (elements) => {
    for (const element of elements) {
      if (!(element instanceof HTMLVideoElement)) throw new Error('Expected video');
      const muted = element.muted;
      element.muted = true;
      await element.play();
      element.pause();
      element.muted = muted;
    }
  });
}
