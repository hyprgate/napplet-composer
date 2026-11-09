// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { outbox, relay, upload } from '@napplet/sdk';
import App from './App.svelte';

let composeOpenHandler: ((payload: unknown) => void) | null = null;
const mockSearchRelatrProfiles = vi.hoisted(() => vi.fn());
const mockResolveMentionRelayHints = vi.hoisted(() => vi.fn());

vi.mock('@napplet/sdk', () => ({
  intent: {
    onDelivery: vi.fn((handler: (payload: unknown) => void) => {
      composeOpenHandler = handler;
      return { close: vi.fn() };
    }),
  },
  identity: {
    getPublicKey: vi.fn().mockResolvedValue('d'.repeat(64)),
  },
  relay: {
    subscribe: vi.fn(() => ({ close: vi.fn() })),
  },
  outbox: {
    publish: vi.fn().mockResolvedValue({ ok: true, eventId: 'reply' }),
  },
  upload: {
    upload: vi.fn().mockResolvedValue({
      ok: true,
      uploadId: 'upload-1',
      status: 'complete',
      rail: 'blossom',
      url: 'https://blossom.example/image.png',
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      nip94: [
        ['url', 'https://blossom.example/image.png'],
        ['m', 'image/png'],
        ['x', 'a'.repeat(64)],
      ],
    }),
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

  it('publishes a reply when INTENT provides reply context', async () => {
    const replyId = 'b'.repeat(64);
    const replyPubkey = 'a'.repeat(64);

    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();

    composeOpenHandler?.({
      archetype: 'composer', action: 'open', convention: 'napplet:composer/open',
      sender: 'hyprgate-shell',
      payload: {
        intent: 'reply',
        replyTo: {
          id: replyId,
          pubkey: replyPubkey,
          kind: 1,
          content: 'This is the note being replied to. It should be visible above the composer.',
          created_at: 1780531200,
        },
      },
    });
    await tick();

    expect(document.body.textContent).toContain('Replying to npub1');
    expect(document.body.textContent).not.toContain(replyId.slice(0, 12));
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
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Published');
    });

    expect(outbox.publish).toHaveBeenCalledWith(expect.objectContaining({
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

  function deliverReply(pubkey: string): void {
    composeOpenHandler?.({
      archetype: 'composer', action: 'open', convention: 'napplet:composer/open', sender: 'hyprgate-shell',
      payload: { source: { napplet: 'feed' }, intent: 'reply', replyTo: { id: 'b'.repeat(64), pubkey, kind: 1, content: 'hello', created_at: 1 } },
    });
  }

  it('shows who a reply is for, by name once metadata arrives and by npub before that', async () => {
    const pubkey = 'a'.repeat(64);
    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();
    deliverReply(pubkey);
    await flushAsync();

    const label = () => document.querySelector('.reply-name')?.textContent ?? '';
    expect(label()).toMatch(/^Replying to npub1/);
    expect(document.body.textContent).not.toContain('aaaaaaaa');

    const call = vi.mocked(relay.subscribe).mock.calls.find(([filter]) => (filter as { authors?: string[] }).authors?.[0] === pubkey);
    (call?.[1] as (result: unknown) => void)({
      event: { kind: 0, pubkey, created_at: 5, content: JSON.stringify({ display_name: 'Ines' }), tags: [], id: 'c', sig: 's' },
    });
    await flushAsync();
    expect(label()).toBe('Replying to Ines');
  });

  it('stops being a reply after publishing, or when told to', async () => {
    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();
    deliverReply('a'.repeat(64));
    await flushAsync();

    const button = (name: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
    button('Not a reply')?.click();
    await flushAsync();
    expect(document.querySelector('[aria-label="Reply context"]')).toBeNull();

    deliverReply('a'.repeat(64));
    await flushAsync();
    const textarea = document.querySelector('textarea')!;
    textarea.value = 'answer';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsync();
    button('Publish')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Published'));
    expect(document.querySelector('[aria-label="Reply context"]')).toBeNull();
  });

  it('keeps the note and explains a read-only session when publishing fails', async () => {
    vi.mocked(outbox.publish).mockRejectedValueOnce(new Error('Cant sign events with readonly'));
    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();
    const textarea = document.querySelector('textarea')!;
    textarea.value = 'kept';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsync();
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Publish')?.click();
    await vi.waitFor(() => expect(document.querySelector('.message.bad')?.textContent).toContain('read-only'));
    expect(textarea.value).toBe('kept');
  });

  it('says why Publish is disabled and previews what will be posted', async () => {
    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();
    expect(document.querySelector('.publish-hint')?.textContent).toBe('Write something to publish');
    expect(document.querySelector('.preview-note')).toBeNull();

    const textarea = document.querySelector('textarea')!;
    textarea.value = 'hello #there';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsync();
    expect(document.querySelector('.publish-hint')).toBeNull();
    expect(document.querySelector('.preview-note')?.textContent).toContain('hello #there');
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

    expect(outbox.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 1,
      content: expect.stringMatching(/^hello nostr:nprofile1/),
    }));
  });

  it('uploads an attached image before publishing its URL and imeta through outbox', async () => {
    component = mount(App, { target: document.body }) as Record<string, never>;
    await flushAsync();

    const file = new File(['image bytes'], 'image.png', { type: 'image/png' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flushAsync();

    const publishButton = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Publish');
    publishButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Published');
    });

    expect(upload.upload).toHaveBeenCalledWith(expect.objectContaining({
      data: file,
      filename: 'image.png',
      mimeType: 'image/png',
    }));
    expect(outbox.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 1,
      content: 'https://blossom.example/image.png',
      tags: expect.arrayContaining([
        [
          'imeta',
          'url https://blossom.example/image.png',
          'm image/png',
          `x ${'a'.repeat(64)}`,
        ],
      ]),
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
