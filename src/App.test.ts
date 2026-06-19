// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { relay } from '@napplet/sdk';
import App from './App.svelte';

let composeOpenHandler: ((payload: unknown) => void) | null = null;
const mockSearchRelatrProfiles = vi.hoisted(() => vi.fn());
const mockResolveMentionRelayHints = vi.hoisted(() => vi.fn());

vi.mock('@napplet/sdk', () => ({
  inc: {
    emit: vi.fn(),
    on: vi.fn((_topic: string, handler: (payload: unknown) => void) => {
      composeOpenHandler = handler;
      return { close: vi.fn() };
    }),
  },
  relay: {
    publish: vi.fn().mockResolvedValue({ id: 'reply' }),
  },
  storage: {
    getItem: vi.fn().mockResolvedValue(''),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@napplet/nap/resource', () => ({
  resourceBytesAsObjectURL: vi.fn((url: string) => ({
    url,
    ready: Promise.resolve(),
    revoke: vi.fn(),
  })),
}));

vi.mock('./lib/relatr-mentions.js', () => ({
  searchRelatrProfiles: mockSearchRelatrProfiles,
  resolveMentionRelayHints: mockResolveMentionRelayHints,
}));

async function flushAsync(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
}

describe('compose app reply context', () => {
  let component: Record<string, never> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    composeOpenHandler = null;
    document.body.innerHTML = '';
    mockSearchRelatrProfiles.mockResolvedValue([]);
    mockResolveMentionRelayHints.mockResolvedValue([]);
  });

  afterEach(() => {
    if (component) unmount(component);
    component = null;
    document.body.innerHTML = '';
  });

  it('publishes a reply when compose:open provides reply context', async () => {
    const replyId = 'b'.repeat(64);
    const replyPubkey = 'a'.repeat(64);

    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();

    composeOpenHandler?.({
      intent: 'reply',
      replyTo: {
        id: replyId,
        pubkey: replyPubkey,
        kind: 1,
        content: 'This is the note being replied to. It should be visible above the composer.',
        created_at: 1780531200,
      },
    });
    await tick();

    expect(document.body.textContent).toContain(`replying to ${replyId.slice(0, 12)}...`);
    expect(document.body.textContent).toContain('replying to:');
    expect(document.body.textContent).toContain('This is the note being replied to.');

    const textarea = document.querySelector('textarea');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    textarea!.value = 'reply body #Nostr #Dev';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    textarea!.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'v' }));
    await tick();

    expect(document.body.textContent).toContain('#nostr');
    expect(document.body.textContent).toContain('#dev');

    textarea!.value = 'reply body #Nostr';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    textarea!.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Backspace' }));
    await tick();

    expect(document.body.textContent).toContain('#nostr');
    expect(document.body.textContent).not.toContain('#dev');

    const publishButton = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Publish');
    publishButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    expect(relay.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 1,
      content: 'reply body #Nostr',
      tags: [
        ['e', replyId, '', 'root'],
        ['p', replyPubkey],
        ['t', 'nostr'],
        ['client', '@hyprgate/composer'],
      ],
    }));
  });

  it('searches Relatr for @mentions, supports keyboard selection, and publishes nostr references', async () => {
    const alicePubkey = 'a'.repeat(64);
    mockSearchRelatrProfiles.mockResolvedValueOnce([{
      pubkey: alicePubkey,
      displayName: 'Alice',
      picture: 'https://example.com/alice.png',
      trustScore: 0.91,
      rank: 1,
      exactMatch: true,
    }]);
    mockResolveMentionRelayHints.mockResolvedValueOnce(['wss://relay.example']);

    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();

    const textarea = document.querySelector('textarea');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    textarea!.value = 'hello @al';
    textarea!.selectionStart = textarea!.value.length;
    textarea!.selectionEnd = textarea!.value.length;
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsync();

    expect(mockSearchRelatrProfiles).toHaveBeenCalledWith('al');
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Alice');

    textarea!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await flushAsync();

    expect(mockResolveMentionRelayHints).toHaveBeenCalledWith(alicePubkey);
    expect(textarea!.value).toBe('hello @Alice ');
    expect(document.body.textContent).toContain('@Alice');

    const publishButton = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Publish');
    publishButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    expect(relay.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 1,
      content: expect.stringMatching(/^hello nostr:nprofile1/),
    }));
  });

  it('supports ArrowDown plus Tab selection in the mention list', async () => {
    mockSearchRelatrProfiles.mockResolvedValueOnce([
      {
        pubkey: 'a'.repeat(64),
        displayName: 'Alice',
        picture: null,
        trustScore: 0.91,
        rank: 1,
        exactMatch: true,
      },
      {
        pubkey: 'b'.repeat(64),
        displayName: 'Bob',
        picture: null,
        trustScore: 0.7,
        rank: 2,
        exactMatch: false,
      },
    ]);
    mockResolveMentionRelayHints.mockResolvedValueOnce([]);

    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();

    const textarea = document.querySelector('textarea')!;
    textarea.value = '@bo';
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsync();

    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
    await flushAsync();

    expect(textarea.value).toBe('@Bob ');
  });

  it('supports mouse selection in the mention list', async () => {
    mockSearchRelatrProfiles.mockResolvedValueOnce([{
      pubkey: 'd'.repeat(64),
      displayName: 'Dana',
      picture: null,
      trustScore: 0.64,
      rank: 1,
      exactMatch: true,
    }]);
    mockResolveMentionRelayHints.mockResolvedValueOnce([]);

    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();

    const textarea = document.querySelector('textarea')!;
    textarea.value = 'cc @da';
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsync();

    document.querySelector<HTMLButtonElement>('.mention-option')?.click();
    await flushAsync();

    expect(textarea.value).toBe('cc @Dana ');
  });
});
