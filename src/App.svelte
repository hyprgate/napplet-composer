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
    buildAttachmentPlaceholder,
    replaceAttachmentPlaceholders,
    buildImetaTag,
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
  import {
    activeAttachments,
    createAttachment,
    uploadComposeFile,
    type ComposeAttachment,
  } from './lib/compose-uploads.js';

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
  let attachments = $state<ComposeAttachment[]>([]);
  let dragging = $state(false);
  let fileInput: HTMLInputElement | null = $state(null);
  let selectionAnchor = 0;
  let mentionSearchSeq = 0;

  let canPublish = $derived(
    (content.trim().length > 0 || attachments.length > 0) && status !== 'publishing',
  );
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
    syncAttachments();
    updateMentionQuery();
    captureSelection();
  }

  function captureSelection(): void {
    if (textarea) selectionAnchor = textarea.selectionStart ?? content.length;
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

  function nextAttachmentId(): string {
    return typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `att-${Date.now()}-${attachments.length}`;
  }

  function createPreview(file: File): string | null {
    try {
      return URL.createObjectURL(file);
    } catch {
      return null;
    }
  }

  /** Insert text into content at `pos`, keeping mention offsets after it valid. */
  function insertTextAtCursor(insertText: string, pos: number): void {
    const at = Math.max(0, Math.min(pos, content.length));
    content = `${content.slice(0, at)}${insertText}${content.slice(at)}`;
    const delta = insertText.length;
    selectedMentions = selectedMentions.map((mention) =>
      mention.start >= at ? { ...mention, start: mention.start + delta, end: mention.end + delta } : mention,
    );
  }

  /** Remove the first occurrence of `token`, keeping mention offsets after it valid. */
  function removeToken(token: string): void {
    const at = content.indexOf(token);
    if (at < 0) return;
    content = `${content.slice(0, at)}${content.slice(at + token.length)}`;
    const delta = token.length;
    selectedMentions = selectedMentions.map((mention) =>
      mention.start >= at + delta ? { ...mention, start: mention.start - delta, end: mention.end - delta } : mention,
    );
  }

  /** Stage dropped/pasted/picked files: insert an obvious inline placeholder at
   *  the cursor for each and track the file for upload at publish time. */
  async function stageFiles(files: Iterable<File>, pos: number): Promise<void> {
    const list = [...files];
    if (list.length === 0) return;
    let cursor = Math.max(0, Math.min(pos, content.length));
    const staged: ComposeAttachment[] = [];
    for (const file of list) {
      const placeholder = buildAttachmentPlaceholder(file.name, content);
      const insertText = cursor > 0 && !/\s$/.test(content.slice(0, cursor)) ? ` ${placeholder} ` : `${placeholder} `;
      insertTextAtCursor(insertText, cursor);
      cursor += insertText.length;
      staged.push(createAttachment(file, nextAttachmentId(), placeholder, createPreview));
    }
    attachments = [...attachments, ...staged];
    if (message) message = '';
    await tick();
    textarea?.focus();
    textarea?.setSelectionRange(cursor, cursor);
    selectionAnchor = cursor;
  }

  /** Drop attachments whose inline placeholder the user has deleted from the text. */
  function syncAttachments(): void {
    const kept = activeAttachments(attachments, content);
    if (kept.length === attachments.length) return;
    for (const attachment of attachments) {
      if (!kept.includes(attachment) && attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    attachments = kept;
  }

  function updateAttachment(id: string, patch: Partial<ComposeAttachment>): void {
    attachments = attachments.map((attachment) =>
      attachment.id === id ? { ...attachment, ...patch } : attachment,
    );
  }

  function removeAttachment(id: string): void {
    const target = attachments.find((attachment) => attachment.id === id);
    if (!target) return;
    if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);
    removeToken(target.placeholder);
    attachments = attachments.filter((attachment) => attachment.id !== id);
  }

  function clearAttachments(): void {
    for (const attachment of attachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    attachments = [];
  }

  function filesFromDataTransfer(data: DataTransfer | null): File[] {
    if (!data) return [];
    if (data.files.length > 0) return [...data.files];
    return [...data.items]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
  }

  function onPaste(event: ClipboardEvent): void {
    const files = filesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    const pos = textarea?.selectionStart ?? content.length;
    void stageFiles(files, pos);
  }

  function onDragOver(event: DragEvent): void {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    dragging = true;
  }

  function onDragLeave(event: DragEvent): void {
    if (event.currentTarget instanceof Node && event.relatedTarget instanceof Node
      && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    dragging = false;
  }

  function onDrop(event: DragEvent): void {
    const files = filesFromDataTransfer(event.dataTransfer);
    dragging = false;
    if (files.length === 0) return;
    event.preventDefault();
    void stageFiles(files, selectionAnchor);
  }

  function openFilePicker(): void {
    // Preserve the caret the user left in the textarea before focus moved to the button.
    captureSelection();
    fileInput?.click();
  }

  function onFileInputChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files) void stageFiles(input.files, selectionAnchor);
    input.value = '';
  }

  /** Upload the given attachments, reusing any already-uploaded result. Only the
   *  attachments still referenced by the note should be passed in. */
  async function uploadAttachments(active: ComposeAttachment[]): Promise<void> {
    for (const attachment of active) {
      if (attachment.status === 'uploaded' && attachment.media) continue;
      updateAttachment(attachment.id, { status: 'uploading', error: undefined });
      try {
        const uploaded = await uploadComposeFile(attachment.file);
        updateAttachment(attachment.id, { status: 'uploaded', media: uploaded, error: undefined });
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'upload failed';
        updateAttachment(attachment.id, { status: 'error', error: reason });
        throw new Error(`Could not upload ${attachment.name}: ${reason}`);
      }
    }
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
    // Drop attachments whose inline placeholder the user deleted, so we never
    // upload media that is no longer part of the note.
    syncAttachments();
    const text = serializeSelectedMentions(content, selectedMentions).trim();
    if ((!text && attachments.length === 0) || status === 'publishing') return;
    status = 'publishing';
    message = '';
    try {
      // Upload staged files only now, at publish time, so unposted drafts never
      // push bytes to a storage server, and only files still referenced by the
      // note. A failed upload aborts the whole post and leaves the attachments
      // in place for retry.
      const active = activeAttachments(attachments, content);
      await uploadAttachments(active);
      // Re-read from state: uploadAttachments replaces attachment objects as it
      // records each result, so the pre-upload `active` snapshot lacks `media`.
      const uploaded = activeAttachments(attachments, content).filter((attachment) => attachment.media);
      const finalContent = replaceAttachmentPlaceholders(
        text,
        uploaded.map((attachment) => ({ placeholder: attachment.placeholder, url: attachment.media!.url })),
      );
      const tags = [
        ...buildComposePublishTags(text, replyContext),
        ...uploaded.map((attachment) => buildImetaTag(attachment.media!)),
      ];
      await publishTextNote(finalContent, tags);
      content = '';
      mentionQuery = null;
      selectedMentions = [];
      clearAttachments();
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
    composeOpenSub = ipc.on(COMPOSER_OPEN_TOPIC, (event) => {
      const nextReplyContext = replyContextFromPayload(event.payload);
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
      for (const attachment of attachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  });
</script>

<main class="compose-app">
  <section
    class="editor"
    class:dragging
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
    role="group"
    aria-label="Compose editor"
  >
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
      onmouseup={() => { updateMentionQuery(); captureSelection(); }}
      onkeyup={captureSelection}
      onkeydown={onKeydown}
      onpaste={onPaste}
      disabled={status === 'loading' || status === 'publishing'}
      aria-label="Compose note"
    ></textarea>

    {#if attachments.length > 0}
      <div class="attachments" aria-label="Attachments">
        {#each attachments as attachment (attachment.id)}
          <figure class="attachment" class:error={attachment.status === 'error'} title={attachment.name}>
            <div class="attachment-preview">
              {#if attachment.previewUrl && attachment.kind === 'image'}
                <img src={attachment.previewUrl} alt={attachment.name} />
              {:else if attachment.previewUrl && attachment.kind === 'video'}
                <video src={attachment.previewUrl} muted preload="metadata"><track kind="captions" /></video>
              {:else}
                <span class="attachment-icon">{attachment.kind === 'audio' ? '♪' : '⎘'}</span>
              {/if}
              {#if attachment.status === 'uploading'}
                <span class="attachment-status" aria-label="Uploading">uploading…</span>
              {:else if attachment.status === 'uploaded'}
                <span class="attachment-status ok" aria-label="Uploaded">✓</span>
              {:else if attachment.status === 'error'}
                <span class="attachment-status bad" aria-label="Upload failed">!</span>
              {/if}
              {#if status !== 'publishing'}
                <button
                  type="button"
                  class="attachment-remove"
                  aria-label={`Remove ${attachment.name}`}
                  onclick={() => removeAttachment(attachment.id)}
                >×</button>
              {/if}
            </div>
            <figcaption>{attachment.name}</figcaption>
          </figure>
        {/each}
      </div>
    {/if}

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
                <span>{profile.displayName.slice(0, 1).toUpperCase()}</span>
                {#if profile.picture}
                  <img use:resourceImage={profile.picture} alt="" loading="lazy" />
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
    <div class="footer-start">
      <button
        type="button"
        class="secondary attach"
        onclick={openFilePicker}
        disabled={status === 'publishing'}
        aria-label="Attach a file"
        title="Attach a file"
      >📎 Attach</button>
      <button type="button" class="secondary" onclick={saveDraft} disabled={status === 'publishing'}>
        Save draft
      </button>
    </div>
    <button type="button" class="primary" onclick={publish} disabled={!canPublish}>
      {status === 'publishing' ? 'Publishing...' : 'Publish'}
    </button>
    <input
      bind:this={fileInput}
      type="file"
      multiple
      class="file-input"
      onchange={onFileInputChange}
      aria-hidden="true"
      tabindex="-1"
    />
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

  .editor.dragging {
    border-color: var(--hg-accent-cyan, #82d8f7);
    box-shadow: inset 0 0 0 1px var(--hg-accent-cyan, #82d8f7);
  }

  .attachments {
    display: flex;
    gap: 8px;
    padding: 8px 10px;
    border-top: 1px solid var(--hg-border, #303030);
    overflow-x: auto;
    flex-wrap: nowrap;
  }

  .attachment {
    display: grid;
    gap: 4px;
    margin: 0;
    width: 76px;
    flex: 0 0 auto;
  }

  .attachment-preview {
    position: relative;
    display: grid;
    place-items: center;
    width: 76px;
    height: 76px;
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    background: color-mix(in srgb, var(--hg-surface, #101010) 80%, var(--hg-bg-base, #050505));
    overflow: hidden;
  }

  .attachment.error .attachment-preview {
    border-color: var(--hg-accent-red, #ff6b6b);
  }

  .attachment-preview img,
  .attachment-preview video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .attachment-icon {
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 24px;
  }

  .attachment-status {
    position: absolute;
    left: 4px;
    bottom: 4px;
    padding: 0 5px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 70%, transparent);
    color: var(--hg-text-primary, #f2efe7);
    font-size: 10px;
    line-height: 16px;
  }

  .attachment-status.ok {
    color: var(--hg-accent-green, #9be564);
  }

  .attachment-status.bad {
    color: var(--hg-accent-red, #ff6b6b);
  }

  .attachment-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 65%, transparent);
    color: var(--hg-text-primary, #f2efe7);
    font-size: 13px;
    line-height: 1;
  }

  .attachment figcaption {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 10px;
  }

  .file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    border: 0;
  }

  .footer-start {
    display: flex;
    align-items: center;
    gap: 10px;
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

  .mention-avatar > span,
  .mention-avatar > img {
    grid-area: 1 / 1;
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
