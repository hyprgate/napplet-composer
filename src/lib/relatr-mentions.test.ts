import { describe, expect, it, vi } from 'vitest';
import {
  RELATR_REQUEST_OPTIONS,
  RELATR_SERVER,
  resolveMentionRelayHints,
  searchRelatrProfiles,
} from './relatr-mentions.js';
import { buildMentionReference } from '@hyprgate/utils';

const alicePubkey = 'a'.repeat(64);
const bobPubkey = 'b'.repeat(64);

describe('relatr mention search', () => {
  it('calls Relatr search_profiles and enriches pubkeys with kind-0 profile metadata', async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: {
        results: [
          { pubkey: alicePubkey, trustScore: 0.91, rank: 1, exactMatch: true },
          { pubkey: bobPubkey, trustScore: 0.45, rank: 2 },
        ],
      },
    });
    const relayQuery = vi.fn().mockResolvedValue([
      {
        kind: 0,
        pubkey: alicePubkey,
        content: JSON.stringify({ name: 'Alice', picture: 'https://example.com/alice.png' }),
      },
      {
        kind: 0,
        pubkey: bobPubkey,
        content: JSON.stringify({ display_name: 'Bob Builder' }),
      },
    ]);

    await expect(searchRelatrProfiles('alice', { callTool, relayQuery })).resolves.toEqual([
      {
        pubkey: alicePubkey,
        displayName: 'Alice',
        picture: 'https://example.com/alice.png',
        trustScore: 0.91,
        rank: 1,
        exactMatch: true,
      },
      {
        pubkey: bobPubkey,
        displayName: 'Bob Builder',
        picture: null,
        trustScore: 0.45,
        rank: 2,
        exactMatch: false,
      },
    ]);

    expect(callTool).toHaveBeenCalledWith(
      RELATR_SERVER,
      'search_profiles',
      { query: 'alice', limit: 12, extendToNostr: true },
      RELATR_REQUEST_OPTIONS,
    );
    expect(relayQuery).toHaveBeenCalledWith([
      { kinds: [0], authors: [alicePubkey], limit: 1 },
      { kinds: [0], authors: [bobPubkey], limit: 1 },
    ]);
  });

  it('uses profile super relays before falling back to generic relay query', async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: {
        results: [
          { pubkey: alicePubkey, trustScore: 0.91, rank: 1 },
          { pubkey: bobPubkey, trustScore: 0.45, rank: 2 },
        ],
      },
    });
    const relayQuery = vi.fn().mockResolvedValue([
      {
        kind: 0,
        pubkey: bobPubkey,
        content: JSON.stringify({ name: 'Bob' }),
      },
    ]);
    const relaySubscribe = vi.fn((filters, onEvent, onEose) => {
      onEvent({
        kind: 0,
        pubkey: alicePubkey,
        created_at: 2,
        content: JSON.stringify({ name: 'Alice Super' }),
      });
      onEose();
      return { close: vi.fn() };
    });

    await expect(searchRelatrProfiles('alice', { callTool, relayQuery, relaySubscribe })).resolves.toMatchObject([
      { pubkey: alicePubkey, displayName: 'Alice Super' },
      { pubkey: bobPubkey, displayName: 'Bob' },
    ]);

    expect(relaySubscribe).toHaveBeenCalledWith(
      [
        { kinds: [0], authors: [alicePubkey], limit: 1 },
        { kinds: [0], authors: [bobPubkey], limit: 1 },
      ],
      expect.any(Function),
      expect.any(Function),
      { relay: 'wss://purplepag.es' },
    );
    expect(relayQuery).toHaveBeenCalledWith([{ kinds: [0], authors: [bobPubkey], limit: 1 }]);
  });

  it('parses Relatr text-content JSON results when structuredContent is absent', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: [{ pubkey: alicePubkey, trustScore: 0.5, rank: 1 }],
        }),
      }],
    });
    const relayQuery = vi.fn().mockResolvedValue([]);

    const results = await searchRelatrProfiles('alice', { callTool, relayQuery });

    expect(results[0]).toMatchObject({
      pubkey: alicePubkey,
      displayName: `${alicePubkey.slice(0, 8)}...`,
      picture: null,
    });
  });

  it('keeps Relatr pubkey results when profile metadata lookup fails', async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: {
        results: [{ pubkey: alicePubkey, trustScore: 0.91, rank: 1 }],
      },
    });
    const relayQuery = vi.fn().mockRejectedValue(new Error('relay unavailable'));

    await expect(searchRelatrProfiles('alice', { callTool, relayQuery })).resolves.toEqual([{
      pubkey: alicePubkey,
      displayName: `${alicePubkey.slice(0, 8)}...`,
      picture: null,
      trustScore: 0.91,
      rank: 1,
      exactMatch: false,
    }]);
  });

  it('keeps Relatr pubkey results when profile metadata lookup returns no event array', async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: {
        results: [{ pubkey: alicePubkey, trustScore: 0.91, rank: 1 }],
      },
    });
    const relayQuery = vi.fn().mockResolvedValue(undefined);

    await expect(searchRelatrProfiles('alice', { callTool, relayQuery })).resolves.toEqual([{
      pubkey: alicePubkey,
      displayName: `${alicePubkey.slice(0, 8)}...`,
      picture: null,
      trustScore: 0.91,
      rank: 1,
      exactMatch: false,
    }]);
  });

  it('turns direct npub mention queries into selectable Relatr trust-score results', async () => {
    const npub = buildMentionReference(alicePubkey, []).replace(/^nostr:/, '');
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: {
        trustScore: {
          targetPubkey: alicePubkey,
          score: 0.72,
        },
      },
    });
    const relayQuery = vi.fn().mockResolvedValue([
      {
        kind: 0,
        pubkey: alicePubkey,
        content: JSON.stringify({ name: 'Alice' }),
      },
    ]);

    await expect(searchRelatrProfiles(npub, { callTool, relayQuery })).resolves.toEqual([{
      pubkey: alicePubkey,
      displayName: 'Alice',
      picture: null,
      trustScore: 0.72,
      rank: 1,
      exactMatch: true,
    }]);

    expect(callTool).toHaveBeenCalledWith(
      RELATR_SERVER,
      'calculate_trust_score',
      { targetPubkey: alicePubkey },
      RELATR_REQUEST_OPTIONS,
    );
    expect(relayQuery).toHaveBeenCalledWith([{ kinds: [0], authors: [alicePubkey], limit: 1 }]);
  });

  it('resolves NIP-65 relay hints for a selected mention', async () => {
    const relayQuery = vi.fn().mockResolvedValue([
      {
        kind: 10002,
        pubkey: alicePubkey,
        created_at: 10,
        tags: [['r', 'wss://old.example']],
        content: '',
      },
      {
        kind: 10002,
        pubkey: alicePubkey,
        created_at: 12,
        tags: [['r', 'wss://relay.example', 'write']],
        content: '',
      },
    ]);

    await expect(resolveMentionRelayHints(alicePubkey, { relayQuery })).resolves.toEqual(['wss://relay.example']);
    expect(relayQuery).toHaveBeenCalledWith({ kinds: [10002], authors: [alicePubkey], limit: 1 });
  });
});
