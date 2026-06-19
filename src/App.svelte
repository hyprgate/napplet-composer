<script lang="ts">
  import {
    buildHashtagTags,
    buildComposePublishTags,
    clearComposeDraft,
    COMPOSER_OPEN_TOPIC,
    COMPOSER_READY_TOPIC,
    detectMentionQuery,
    insertMentionText,
    loadComposeDraft,
    parseComposeReplyParams,
    previewComposeReplyContent,
    publishTextNote,
    saveComposeDraft,
    serializeSelectedMentions,
    type MentionQuery,
    type ComposeReplyContext,
    type SelectedMention,
    resourceImage,
  } from '@hyprgate/utils';
  import { inc as ipc, type Subscription } from '@napplet/sdk';
  import { onMount, tick } from 'svelte';
  import {
    resolveMentionRelayHints,
    searchRelatrProfiles,
    type MentionProfile,
  } from './lib/relatr-mentions.js';

  let content = $state('');
  let status = $state<'idle' | 'loading' | 'saving' | 'publishing' | 'published' | 'error'>('loading');
  let message = $state('');
  let mentionQuery = $state<string | null>(null);
  let mentionResults = $state<MentionProfile[]>([]);
  let mentionActiveIndex = $state(0);
  let mentionLoading = $state(false);
  let selectedMentions = $state<SelectedMention[]>([]);
  let textarea: HTMLTextAreaElement | null = $state(null);
  let replyContext = $state<ComposeReplyContext | null>(null);
  let mentionSearchSeq = 0;

  let canPublish = $derived(content.trim().length > 0 && status !== 'publishing');
  let charCount = $derived(content.length);
  let hashtags = $derived(buildHashtagTags(content).map((tag) => tag[1]));
  let replyPreviewContent = $derived(
    replyContext?.content ? previewComposeReplyContent(replyContext.content) : null,
  );
  let mentionPanelOpen = $derived(mentionQuery !== null);

  function currentMentionQuery(): MentionQuery | null {
    const cursor = textarea?.selectionStart ?? content.length;
    return detectMentionQuery(content, cursor);
  }

  function normalizeMentionDisplay(name: string): string {
    return name.replace(/\s+/g, '').replace(/^@+/, '') || 'user';
  }

  function syncSelectedMentions(): void {
    selectedMentions = selectedMentions.filter((mention) =>
      content.slice(mention.start, mention.end) === `@${mention.display}`,
    );
  }

  function updateMentionQuery(): void {
    const detected = currentMentionQuery();
    mentionQuery = detected?.query ?? null;
    if (mentionQuery === null) {
      mentionResults = [];
      mentionActiveIndex = 0;
      return;
    }
    void searchMentions(mentionQuery);
  }

  async function searchMentions(query: string): Promise<void> {
    const token = ++mentionSearchSeq;
    mentionActiveIndex = 0;
    if (!query.trim()) {
      mentionResults = [];
      mentionLoading = false;
      return;
    }
    mentionLoading = true;
    try {
      const results = await searchRelatrProfiles(query);
      if (token !== mentionSearchSeq) return;
      mentionResults = results;
    } catch {
      if (token !== mentionSearchSeq) return;
      mentionResults = [];
    } finally {
      if (token === mentionSearchSeq) mentionLoading = false;
    }
  }

  function onInput(): void {
    syncSelectedMentions();
    updateMentionQuery();
  }

  async function selectMention(profile: MentionProfile): Promise<void> {
    const mention = currentMentionQuery();
    if (!mention) return;

    const cursor = textarea?.selectionStart ?? content.length;
    const display = normalizeMentionDisplay(profile.displayName);
    let relays: string[] = [];
    try {
      relays = await resolveMentionRelayHints(profile.pubkey);
    } catch {
      relays = [];
    }

    content = insertMentionText(content, cursor, mention.start, `@${display}`);
    selectedMentions = [
      ...selectedMentions,
      {
        start: mention.start,
        end: mention.start + display.length + 1,
        display,
        pubkey: profile.pubkey,
        relays,
      },
    ];
    mentionQuery = null;
    mentionResults = [];
    mentionActiveIndex = 0;
    await tick();
    const nextCursor = mention.start + display.length + 2;
    textarea?.focus();
    textarea?.setSelectionRange(nextCursor, nextCursor);
  }

  async function saveDraft(): Promise<void> {
    status = 'saving';
    message = '';
    try {
      await saveComposeDraft(content);
      status = 'idle';
      message = content.trim() ? 'Draft saved' : 'Draft cleared';
    } catch (err) {
      status = 'error';
      message = err instanceof Error ? err.message : 'Could not save draft';
    }
  }

  async function publish(): Promise<void> {
    const text = serializeSelectedMentions(content, selectedMentions).trim();
    if (!text || status === 'publishing') return;
    status = 'publishing';
    message = '';
    try {
      await publishTextNote(text, buildComposePublishTags(text, replyContext));
      content = '';
      mentionQuery = null;
      selectedMentions = [];
      await clearComposeDraft();
      status = 'published';
      message = 'Published';
    } catch (err) {
      status = 'error';
      message = err instanceof Error ? err.message : 'Could not publish note';
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (mentionPanelOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        mentionActiveIndex = mentionResults.length === 0 ? 0 : (mentionActiveIndex + 1) % mentionResults.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        mentionActiveIndex = mentionResults.length === 0 ? 0 : (mentionActiveIndex - 1 + mentionResults.length) % mentionResults.length;
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && mentionResults[mentionActiveIndex]) {
        event.preventDefault();
        void selectMention(mentionResults[mentionActiveIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        mentionQuery = null;
        mentionResults = [];
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void publish();
    }
  }

  function replyContextFromPayload(payload: unknown): ComposeReplyContext | null {
    if (!payload || typeof payload !== 'object') return null;
    const value = payload as {
      intent?: unknown;
      replyTo?: { id?: unknown; pubkey?: unknown; kind?: unknown; content?: unknown; created_at?: unknown };
    };
    if (value.intent !== 'reply') return null;
    const id = value.replyTo?.id;
    const pubkey = value.replyTo?.pubkey;
    const kind = Number(value.replyTo?.kind ?? 1);
    if (typeof id !== 'string' || typeof pubkey !== 'string' || !Number.isInteger(kind)) return null;
    return {
      id,
      pubkey,
      kind,
      ...(typeof value.replyTo?.content === 'string' ? { content: value.replyTo.content } : {}),
      ...(typeof value.replyTo?.created_at === 'number' ? { created_at: value.replyTo.created_at } : {}),
    };
  }

  onMount(() => {
    let composeOpenSub: Subscription | null = null;
    composeOpenSub = ipc.on(COMPOSER_OPEN_TOPIC, (payload) => {
      const nextReplyContext = replyContextFromPayload(payload);
      if (nextReplyContext) replyContext = nextReplyContext;
    });
    ipc.emit(COMPOSER_READY_TOPIC);
    replyContext = parseComposeReplyParams(window.location.search);
    loadComposeDraft()
      .then((draft) => {
        content = draft;
        status = 'idle';
      })
      .catch((err) => {
        status = 'error';
        message = err instanceof Error ? err.message : 'Could not load draft';
      });
    return () => {
      composeOpenSub?.close();
    };
  });
</script>

<main class="compose-app">
  <section class="editor">
    {#if replyContext}
      <section class="reply-context" aria-label="Reply context">
        <div class="reply-label">replying to:</div>
        <article class="reply-preview">
          <div class="reply-meta">
            <span>{replyContext.pubkey.slice(0, 12)}...</span>
            <span>kind {replyContext.kind}</span>
          </div>
          {#if replyPreviewContent}
            <p>{replyPreviewContent}</p>
          {:else}
            <p>{replyContext.id.slice(0, 12)}...</p>
          {/if}
        </article>
      </section>
    {/if}

    <textarea
      bind:this={textarea}
      bind:value={content}
      placeholder={replyContext ? 'Write a reply. Use #tags and paste nostr: references.' : 'Write a note. Use #tags and paste nostr: references.'}
      oninput={onInput}
      onmouseup={updateMentionQuery}
      onkeydown={onKeydown}
      disabled={status === 'loading' || status === 'publishing'}
      aria-label="Compose note"
    ></textarea>

    {#if mentionPanelOpen}
      <div class="mention-panel" role="listbox" aria-label="Mention suggestions">
        {#if mentionLoading}
          <div class="mention-empty">searching @{mentionQuery}</div>
        {:else if mentionResults.length > 0}
          {#each mentionResults as profile, index (profile.pubkey)}
            <button
              type="button"
              class:active={index === mentionActiveIndex}
              class="mention-option"
              role="option"
              aria-selected={index === mentionActiveIndex}
              onmousedown={(event) => event.preventDefault()}
              onclick={() => void selectMention(profile)}
            >
              <span class="mention-avatar">
                {#if profile.picture}
                  <img use:resourceImage={profile.picture} alt="" loading="lazy" />
                {:else}
                  <span>{profile.displayName.slice(0, 1).toUpperCase()}</span>
                {/if}
              </span>
              <span class="mention-name">@{profile.displayName}</span>
              <span class="mention-score">{Math.round(profile.trustScore * 100)}%</span>
            </button>
          {/each}
        {:else}
          <div class="mention-empty">{mentionQuery ? `No profiles for @${mentionQuery}` : 'Type to search profiles'}</div>
        {/if}
      </div>
    {/if}

    {#if selectedMentions.length > 0}
      <div class="selected-mentions" aria-label="Selected mentions">
        {#each selectedMentions as mention (`${mention.start}:${mention.pubkey}`)}
          <span class="selected-mention">@{mention.display}</span>
        {/each}
      </div>
    {/if}

    {#if hashtags.length > 0}
      <div class="tag-bubbles" aria-label="Detected hashtags">
        {#each hashtags as tag (tag)}
          <span class="tag-bubble">#{tag}</span>
        {/each}
      </div>
    {/if}

    <div class="meta">
      {#if mentionQuery !== null}
        <span>@{mentionQuery}</span>
      {:else if replyContext}
        <span>replying to {replyContext.id.slice(0, 12)}...</span>
      {:else}
        <span>{hashtags.length > 0 ? `#${hashtags.join(' #')}` : 'No tags yet'}</span>
      {/if}
      <span>{charCount} / {status}</span>
    </div>
  </section>

  {#if message}
    <p class:bad={status === 'error'} class="message">{message}</p>
  {/if}

  <footer>
    <button type="button" class="secondary" onclick={saveDraft} disabled={status === 'publishing'}>
      Save draft
    </button>
    <button type="button" class="primary" onclick={publish} disabled={!canPublish}>
      {status === 'publishing' ? 'Publishing...' : 'Publish'}
    </button>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: var(--hg-bg-base, #050505);
    color: var(--hg-text-primary, #f2efe7);
    font-family: var(--hg-font-body, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  }

  .compose-app {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto auto;
    gap: 12px;
    height: 100vh;
    padding: 14px;
    box-sizing: border-box;
    background: var(--hg-bg-base, #050505);
  }

  footer,
  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .editor {
    display: flex;
    flex-direction: column;
    position: relative;
    min-height: 0;
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    background: var(--hg-surface, #101010);
    overflow: hidden;
  }

  .reply-context {
    display: none;
    padding: 10px 12px;
    border-bottom: 1px solid var(--hg-border, #303030);
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 72%, var(--hg-surface, #101010));
  }

  .reply-label {
    margin-bottom: 6px;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 11px;
    text-transform: lowercase;
  }

  .reply-preview {
    display: grid;
    gap: 5px;
    min-width: 0;
    padding-left: 9px;
    border-left: 2px solid var(--hg-accent-cyan, #82d8f7);
  }

  .reply-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 10px;
  }

  .reply-preview p {
    margin: 0;
    color: var(--hg-text-primary, #f2efe7);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  @media (min-height: 380px) {
    .reply-context {
      display: block;
    }
  }

  textarea {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    padding: 12px;
    box-sizing: border-box;
    border: 0;
    resize: none;
    outline: none;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: 1.5;
  }

  textarea::placeholder {
    color: var(--hg-text-muted, #b8b1a4);
  }

  .tag-bubbles {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 6px 10px;
    border-top: 1px solid var(--hg-border, #303030);
    flex-wrap: wrap;
  }

  .mention-panel {
    position: absolute;
    right: 0;
    bottom: 32px;
    left: 0;
    z-index: 2;
    display: grid;
    gap: 4px;
    max-height: min(300px, 45vh);
    overflow-y: auto;
    padding: 8px 10px;
    border-top: 1px solid var(--hg-border, #303030);
    background: color-mix(in srgb, var(--hg-surface, #101010) 86%, var(--hg-accent-cyan, #82d8f7));
  }

  .mention-option {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 36px;
    padding: 4px 8px;
    text-align: left;
  }

  .mention-option.active {
    border-color: color-mix(in srgb, var(--hg-accent-cyan, #82d8f7) 70%, var(--hg-border, #303030));
    background: color-mix(in srgb, var(--hg-accent-cyan, #82d8f7) 12%, var(--hg-surface, #101010));
  }

  .mention-avatar {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--hg-border, #303030);
    border-radius: 50%;
    overflow: hidden;
    color: var(--hg-accent-cyan, #82d8f7);
    font-size: 11px;
  }

  .mention-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .mention-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--hg-text-primary, #f2efe7);
  }

  .mention-score,
  .mention-empty {
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 11px;
  }

  .mention-empty {
    padding: 4px 2px;
  }

  .selected-mentions {
    display: flex;
    gap: 6px;
    min-height: 30px;
    padding: 5px 10px;
    border-top: 1px solid var(--hg-border, #303030);
    flex-wrap: wrap;
  }

  .selected-mention {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    padding: 0 8px;
    border: 1px solid color-mix(in srgb, var(--hg-accent-cyan, #82d8f7) 50%, var(--hg-border, #303030));
    border-radius: 999px;
    color: var(--hg-accent-cyan, #82d8f7);
    background: color-mix(in srgb, var(--hg-accent-cyan, #82d8f7) 10%, transparent);
    font-size: 11px;
  }

  .tag-bubble {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    min-height: 20px;
    padding: 0 8px;
    border: 1px solid color-mix(in srgb, var(--hg-accent-green, #9be564) 45%, var(--hg-border, #303030));
    border-radius: 999px;
    color: var(--hg-accent-green, #9be564);
    background: color-mix(in srgb, var(--hg-accent-green, #9be564) 10%, transparent);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .meta {
    min-height: 32px;
    padding: 0 10px;
    border-top: 1px solid var(--hg-border, #303030);
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 11px;
  }

  .message {
    margin: 0;
    min-height: 18px;
    color: var(--hg-accent-green, #9be564);
    font-size: 12px;
  }

  .message.bad {
    color: var(--hg-accent-red, #ff6b6b);
  }

  button {
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--hg-border, #303030);
    border-radius: 5px;
    background: var(--hg-surface, #101010);
    color: var(--hg-text-primary, #f2efe7);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .primary {
    border-color: color-mix(in srgb, var(--hg-accent-green, #9be564) 70%, var(--hg-border, #303030));
    color: var(--hg-accent-green, #9be564);
  }

  .secondary {
    color: var(--hg-text-muted, #b8b1a4);
  }
</style>
