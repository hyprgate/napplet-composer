// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import App from './App.svelte';

let composeOpenHandler: ((event: { topic: string; sender: string; payload?: unknown }) => void) | null = null;

vi.mock('@napplet/sdk', () => ({
  inc: {
    emit: vi.fn(),
    on: vi.fn((_topic: string, handler: typeof composeOpenHandler) => {
      composeOpenHandler = handler;
      return { close: vi.fn() };
    }),
  },
  relay: { publish: vi.fn().mockResolvedValue({ id: 'reply' }) },
  storage: {
    getItem: vi.fn().mockResolvedValue(''),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@napplet/nap/resource', () => ({
  resourceBytesAsObjectURL: vi.fn((url: string) => ({ url, ready: Promise.resolve(), revoke: vi.fn() })),
}));

vi.mock('./lib/relatr-mentions.js', () => ({
  searchRelatrProfiles: vi.fn().mockResolvedValue([]),
  resolveMentionRelayHints: vi.fn().mockResolvedValue([]),
}));

const reply = {
  intent: 'reply',
  replyTo: { id: 'b'.repeat(64), pubkey: 'a'.repeat(64), kind: 1, content: 'canonical reply context' },
};

describe('composer canonical INC delivery', () => {
  let component: Record<string, never> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    composeOpenHandler = null;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    if (component) unmount(component);
    component = null;
    document.body.innerHTML = '';
  });

  it.each(['warm direct', 'cold post-ready replay'])('applies one valid %s IncEvent', async (delivery) => {
    expect(delivery).toBeTruthy();
    component = mount(App, { target: document.body }) as Record<string, never>;
    await tick();
    composeOpenHandler?.({ topic: 'compose:open', sender: 'hyprgate-shell', payload: reply });
    await tick();

    expect(document.body.textContent).toContain('replying to:');
    expect(document.body.textContent).toContain('canonical reply context');
  });

  it('ignores absent and malformed IncEvent payloads', async () => {
    component = mount(App, { target: document.body }) as Record<string, never>;
    await tick();
    composeOpenHandler?.({ topic: 'compose:open', sender: 'hyprgate-shell' });
    composeOpenHandler?.({ topic: 'compose:open', sender: 'hyprgate-shell', payload: { intent: 'reply' } });
    await tick();

    expect(document.body.textContent).not.toContain('replying to:');
  });
});
