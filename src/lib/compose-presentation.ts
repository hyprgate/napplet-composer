import { KIND_METADATA } from '@hyprgate/utils';
import { npubEncode } from 'nostr-tools/nip19';

export interface ComposeProfile {
  display_name?: unknown;
  displayName?: unknown;
  name?: unknown;
  nip05?: unknown;
  picture?: unknown;
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

export function shortNpub(pubkey: string): string {
  if (!HEX_PUBKEY.test(pubkey)) return pubkey.slice(0, 12);
  const npub = npubEncode(pubkey);
  return `${npub.slice(0, 12)}...${npub.slice(-6)}`;
}

/** Best-effort name for a person: profile metadata first, a short npub otherwise. */
export function composeProfileName(profile: ComposeProfile | null | undefined, pubkey: string): string {
  for (const candidate of [profile?.display_name, profile?.displayName, profile?.name, profile?.nip05]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return shortNpub(pubkey);
}

export function parseComposeProfile(event: { kind: number; content: string }): ComposeProfile | null {
  if (event.kind !== KIND_METADATA) return null;
  try {
    const parsed: unknown = JSON.parse(event.content);
    return parsed && typeof parsed === 'object' ? parsed as ComposeProfile : null;
  } catch {
    return null;
  }
}

/** Plain-language publish failure. The note stays in the editor either way. */
export function composePublishError(err: unknown): string {
  const reason = err instanceof Error ? err.message : '';
  if (/read.?only/i.test(reason)) {
    return "This session is read-only, so it can't sign notes. Sign in with a key or a signer to publish. Your note is still here.";
  }
  return `Couldn't publish${reason ? `: ${reason}` : ''}. Your note is still here.`;
}

/** Saved drafts only keep text, so attached files have to be picked again. */
export function composeDraftSavedMessage(hasContent: boolean, attachmentCount: number): string {
  if (!hasContent) return 'Draft cleared';
  if (attachmentCount === 0) return 'Draft saved';
  return `Draft saved. Drafts only keep text, so re-attach ${attachmentCount === 1 ? 'the file' : `the ${attachmentCount} files`} if you come back to it.`;
}
