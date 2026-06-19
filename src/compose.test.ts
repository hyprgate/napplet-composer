import { describe, expect, it } from 'vitest';
import { buildHashtagTags, detectMentionQuery } from '@hyprgate/utils';

describe('compose napplet wiring', () => {
  it('uses shared compose helpers for tags and mention detection', () => {
    expect(buildHashtagTags('hello #Nostr')).toEqual([['t', 'nostr']]);
    expect(detectMentionQuery('hello @al', 9)).toEqual({ start: 6, query: 'al' });
  });
});
