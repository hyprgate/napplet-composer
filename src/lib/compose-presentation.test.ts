import { describe, expect, it } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import {
  composeDraftSavedMessage,
  composeProfileName,
  composePublishError,
  parseComposeProfile,
  shortNpub,
} from './compose-presentation';

const PUBKEY = 'c'.repeat(64);

describe('compose presentation', () => {
  it('names people from metadata and falls back to an npub, never hex', () => {
    expect(composeProfileName({ display_name: 'Ada', name: 'ada' }, PUBKEY)).toBe('Ada');
    expect(composeProfileName({ name: 'ada' }, PUBKEY)).toBe('ada');
    const fallback = composeProfileName(null, PUBKEY);
    expect(fallback).toBe(shortNpub(PUBKEY));
    expect(npubEncode(PUBKEY).startsWith(fallback.slice(0, 12))).toBe(true);
    expect(fallback).not.toContain('cccc');
  });

  it('reads only kind 0 metadata', () => {
    expect(parseComposeProfile({ kind: 0, content: '{"name":"ada"}' })).toEqual({ name: 'ada' });
    expect(parseComposeProfile({ kind: 1, content: '{"name":"ada"}' })).toBeNull();
    expect(parseComposeProfile({ kind: 0, content: 'nope' })).toBeNull();
  });

  it('explains a read-only session and keeps other failure reasons', () => {
    expect(composePublishError(new Error('Cant sign events with readonly'))).toContain('read-only');
    expect(composePublishError(new Error('relay said no'))).toBe("Couldn't publish: relay said no. Your note is still here.");
    expect(composePublishError('?')).toBe("Couldn't publish. Your note is still here.");
  });

  it('warns that drafts do not keep attachments', () => {
    expect(composeDraftSavedMessage(true, 0)).toBe('Draft saved');
    expect(composeDraftSavedMessage(false, 0)).toBe('Draft cleared');
    expect(composeDraftSavedMessage(true, 2)).toContain('re-attach the 2 files');
  });
});
