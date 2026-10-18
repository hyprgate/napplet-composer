// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intent } from '@napplet/sdk';
import { mount, tick, unmount } from 'svelte';
import App from './App.svelte';

let composeOpenHandler: ((event: { archetype: string; action: string; convention: string; sender: string; payload?: unknown }) => void) | null = null;

vi.mock('@napplet/sdk', () => ({
  intent: {
    onDelivery: vi.fn((handler: typeof composeOpenHandler) => {
      composeOpenHandler = handler;
      return { close: vi.fn() };
    }),
  },
  outbox: { publish: vi.fn().mockResolvedValue({ ok: true, eventId: 'reply' }) },
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

describe('composer canonical INTENT delivery', () => {
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

  it.each(['warm direct', 'cold buffered delivery'])('applies one valid %s IntentDelivery', async (delivery) => {
    expect(delivery).toBeTruthy();
    component = mount(App, { target: document.body }) as Record<string, never>;
    await tick();
    composeOpenHandler?.({ archetype: 'composer', action: 'open', convention: 'napplet:composer/open', sender: 'hyprgate-shell', payload: reply });
    await tick();

    expect(document.body.textContent).toContain('replying to:');
    expect(document.body.textContent).toContain('canonical reply context');
  });

  it('keeps buffered delivery received synchronously during subscription', async () => {
    vi.mocked(intent.onDelivery).mockImplementationOnce(callback => {
      callback({ archetype: 'composer', action: 'open', convention: 'napplet:composer/open',
        sender: 'host', payload: reply });
      return { close: vi.fn() };
    });
    component = mount(App, { target: document.body }) as Record<string, never>;
    await tick();
    expect(document.body.textContent).toContain('canonical reply context');
  });

  it('ignores another convention even if its payload resembles reply context', async () => {
    component = mount(App, { target: document.body }) as Record<string, never>;
    await tick();
    composeOpenHandler?.({ archetype: 'composer', action: 'edit', convention: 'napplet:composer/edit', sender: 'host', payload: reply });
    await tick();
    expect(document.body.textContent).not.toContain('replying to:');
  });

  it('ignores absent and malformed IntentDelivery payloads', async () => {
    component = mount(App, { target: document.body }) as Record<string, never>;
    await tick();
    composeOpenHandler?.({ archetype: 'composer', action: 'open', convention: 'napplet:composer/open', sender: 'hyprgate-shell' });
    composeOpenHandler?.({ archetype: 'composer', action: 'open', convention: 'napplet:composer/open', sender: 'hyprgate-shell', payload: { intent: 'reply' } });
    await tick();

    expect(document.body.textContent).not.toContain('replying to:');
  });
});
