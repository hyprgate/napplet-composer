import { cvm, relay, type McpToolResult, type NostrEvent } from '@napplet/sdk';
import { decodeMentionProfilePubkey, parseNip65RelayHints } from '@hyprgate/utils';

export const RELATR_SERVER = {
  pubkey: '750682303c9f0ddad75941b49edc9d46e3ed306b9ee3335338a21a3e404c5fa3',
  relays: [
    'wss://relay.contextvm.org',
    'wss://relay2.contextvm.org',
    'wss://relay.primal.net',
  ],
};

export const RELATR_REQUEST_OPTIONS = {
  initialize: true,
  timeoutMs: 30_000,
} as const;

const RELATR_MENTION_LIMIT = 12;
const METADATA_LOOKUP_TIMEOUT_MS = 3_000;
const METADATA_SUPER_RELAY_ATTEMPTS = 2;
const PROFILE_SUPER_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io',
] as const;

export interface MentionProfile {
  pubkey: string;
  displayName: string;
  picture: string | null;
  trustScore: number;
  rank: number;
  exactMatch: boolean;
}

interface RelatrCandidate {
  pubkey: string;
  trustScore: number;
  rank: number;
  exactMatch?: boolean;
}

interface ProfileMetadata {
  name?: string;
  display_name?: string;
  displayName?: string;
  nip05?: string;
  picture?: string;
}

interface NappletShellHandle {
  ready(): Promise<unknown>;
}

interface RelatrToolResult extends McpToolResult {
  structuredContent?: unknown;
}

interface RelatrTrustScoreResult extends McpToolResult {
  structuredContent?: unknown;
}

export interface RelatrMentionDeps {
  callTool?: typeof cvm.callTool;
  relayQuery?: typeof relay.query;
  relaySubscribe?: typeof relay.subscribe;
}

function getShell(): NappletShellHandle | null {
  return (globalThis as unknown as { napplet?: { shell?: NappletShellHandle } }).napplet?.shell ?? null;
}

async function waitForShellReady(): Promise<void> {
  await getShell()?.ready();
}

function isRelatrCandidate(value: unknown): value is RelatrCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RelatrCandidate>;
  return typeof candidate.pubkey === 'string'
    && typeof candidate.trustScore === 'number'
    && typeof candidate.rank === 'number';
}

function extractCandidates(result: RelatrToolResult): RelatrCandidate[] {
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object') {
    const results = (structured as { results?: unknown }).results;
    if (Array.isArray(results)) return results.filter(isRelatrCandidate);
  }

  for (const block of result.content ?? []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text) as { results?: unknown };
      if (Array.isArray(parsed.results)) return parsed.results.filter(isRelatrCandidate);
    } catch {
      // Continue scanning other content blocks.
    }
  }

  return [];
}

function extractTrustScore(result: RelatrTrustScoreResult): number {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== 'object') return 0;
  const trustScore = (structured as { trustScore?: unknown }).trustScore;
  if (!trustScore || typeof trustScore !== 'object') return 0;
  const score = (trustScore as { score?: unknown }).score;
  return typeof score === 'number' && Number.isFinite(score) ? score : 0;
}

function parseProfileContent(content: string): ProfileMetadata | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as ProfileMetadata : null;
  } catch {
    return null;
  }
}

function profileName(pubkey: string, metadata: ProfileMetadata | null | undefined): string {
  const candidates = [
    metadata?.display_name,
    metadata?.displayName,
    metadata?.name,
    metadata?.nip05,
  ];
  return candidates.find((name) => typeof name === 'string' && name.trim().length > 0)?.trim()
    ?? `${pubkey.slice(0, 8)}...`;
}

function latestKind0Events(events: NostrEvent[]): NostrEvent[] {
  const latest = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== 0 || typeof event.pubkey !== 'string') continue;
    const existing = latest.get(event.pubkey);
    if (!existing || (event.created_at ?? 0) > (existing.created_at ?? 0)) {
      latest.set(event.pubkey, event);
    }
  }
  return [...latest.values()];
}

function metadataFromEvents(events: NostrEvent[]): Map<string, ProfileMetadata> {
  const metadata = new Map<string, ProfileMetadata>();
  for (const event of latestKind0Events(events)) {
    const parsed = parseProfileContent(event.content);
    if (parsed) metadata.set(event.pubkey, parsed);
  }
  return metadata;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('metadata lookup timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectProfileEventsFromRelay(
  pubkeys: string[],
  relayUrl: string,
  relaySubscribe: typeof relay.subscribe,
): Promise<NostrEvent[]> {
  if (pubkeys.length === 0) return [];
  await waitForShellReady();
  const wanted = new Set(pubkeys);
  const found = new Map<string, NostrEvent>();

  return new Promise((resolve) => {
    let subscription: ReturnType<typeof relay.subscribe> | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.close();
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, METADATA_LOOKUP_TIMEOUT_MS);

    try {
      subscription = relaySubscribe(
        pubkeys.map((pubkey) => ({ kinds: [0], authors: [pubkey], limit: 1 })),
        (event) => {
          if (event.kind !== 0 || !wanted.has(event.pubkey)) return;
          const existing = found.get(event.pubkey);
          if (!existing || (event.created_at ?? 0) > (existing.created_at ?? 0)) {
            found.set(event.pubkey, event);
          }
          if (found.size >= wanted.size) finish();
        },
        finish,
        { relay: relayUrl },
      );
    } catch {
      finish();
    }
  });
}

async function collectProfileEventsFromSuperRelays(
  pubkeys: string[],
  relaySubscribe: typeof relay.subscribe,
): Promise<NostrEvent[]> {
  const collected: NostrEvent[] = [];
  let missingPubkeys = [...new Set(pubkeys)];

  for (let attempt = 0; attempt < METADATA_SUPER_RELAY_ATTEMPTS && missingPubkeys.length > 0; attempt++) {
    const results = await Promise.all(
      PROFILE_SUPER_RELAYS.map((relayUrl) => collectProfileEventsFromRelay(missingPubkeys, relayUrl, relaySubscribe)),
    );
    collected.push(...results.flat());
    const foundPubkeys = new Set(latestKind0Events(collected).map((event) => event.pubkey));
    missingPubkeys = missingPubkeys.filter((pubkey) => !foundPubkeys.has(pubkey));
  }

  return latestKind0Events(collected);
}

async function loadProfileMetadata(
  pubkeys: string[],
  relayQuery: typeof relay.query,
  relaySubscribe?: typeof relay.subscribe,
): Promise<Map<string, ProfileMetadata>> {
  if (pubkeys.length === 0) return new Map();
  let metadata = new Map<string, ProfileMetadata>();

  if (relaySubscribe) {
    metadata = metadataFromEvents(await collectProfileEventsFromSuperRelays(pubkeys, relaySubscribe));
    if (metadata.size >= pubkeys.length) return metadata;
  }

  const missingPubkeys = pubkeys.filter((pubkey) => !metadata.has(pubkey));
  if (missingPubkeys.length === 0) return metadata;

  try {
    const result = await withTimeout(
      relayQuery(missingPubkeys.map((pubkey) => ({ kinds: [0], authors: [pubkey], limit: 1 }))) as Promise<NostrEvent[]>,
      METADATA_LOOKUP_TIMEOUT_MS,
    );
    for (const [pubkey, profile] of metadataFromEvents(Array.isArray(result) ? result : [])) {
      metadata.set(pubkey, profile);
    }
  } catch {
    return metadata;
  }

  return metadata;
}

export async function searchRelatrProfiles(
  rawQuery: string,
  deps: RelatrMentionDeps = {},
): Promise<MentionProfile[]> {
  const query = rawQuery.trim();
  if (!query) return [];

  const callTool = deps.callTool ?? cvm.callTool;
  const relayQuery = deps.relayQuery ?? relay.query;
  const relaySubscribe = deps.relaySubscribe ?? relay.subscribe;
  const directPubkey = decodeMentionProfilePubkey(query);
  let candidates: RelatrCandidate[];

  if (directPubkey) {
    let trustScore = 0;
    try {
      const scoreResult = await callTool(
        RELATR_SERVER,
        'calculate_trust_score',
        { targetPubkey: directPubkey },
        RELATR_REQUEST_OPTIONS,
      ) as RelatrTrustScoreResult;
      trustScore = extractTrustScore(scoreResult);
    } catch {
      // Direct pubkey mentions should remain selectable even if trust scoring is unavailable.
    }
    candidates = [{ pubkey: directPubkey, trustScore, rank: 1, exactMatch: true }];
  } else {
    const result = await callTool(
      RELATR_SERVER,
      'search_profiles',
      { query, limit: RELATR_MENTION_LIMIT, extendToNostr: true },
      RELATR_REQUEST_OPTIONS,
    ) as RelatrToolResult;
    candidates = extractCandidates(result).slice(0, RELATR_MENTION_LIMIT);
  }

  const metadata = await loadProfileMetadata(
    candidates.map((candidate) => candidate.pubkey),
    relayQuery,
    relaySubscribe,
  );

  return candidates.map((candidate) => {
    const profile = metadata.get(candidate.pubkey);
    return {
      pubkey: candidate.pubkey,
      displayName: profileName(candidate.pubkey, profile),
      picture: typeof profile?.picture === 'string' && profile.picture.trim() ? profile.picture : null,
      trustScore: candidate.trustScore,
      rank: candidate.rank,
      exactMatch: candidate.exactMatch === true,
    };
  });
}

export async function resolveMentionRelayHints(
  pubkey: string,
  deps: Pick<RelatrMentionDeps, 'relayQuery'> = {},
): Promise<string[]> {
  const relayQuery = deps.relayQuery ?? relay.query;
  const events = await relayQuery({ kinds: [10002], authors: [pubkey], limit: 1 }) as NostrEvent[];
  const latest = [...events]
    .filter((event) => event.kind === 10002)
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  return parseNip65RelayHints(latest);
}
