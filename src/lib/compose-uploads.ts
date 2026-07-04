/**
 * compose-uploads.ts — NAP-UPLOAD client wrapper for the composer.
 *
 * The composer stages files locally (paste, drag-drop, or the attachment
 * button) and shows placeholders. Bytes are only handed to the shell's upload
 * service (`upload.upload`) when the user publishes the note — the shell selects
 * a server, signs the rail authorization (NIP-98 for NIP-96, kind 24242 for
 * Blossom), performs the HTTP upload, and returns a stable URL plus NIP-94
 * integrity metadata. Napplets never see signing keys, server credentials, or
 * direct network access — the host is the policy/consent boundary.
 */

import { upload, type UploadResult } from '@napplet/sdk';
import type { UploadedMedia } from '@hyprgate/utils';

/** Lifecycle of a locally-staged attachment before/while/after upload. */
export type AttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

/**
 * A file staged in the composer. `placeholder` is the obvious inline token shown
 * in the note text at the cursor; it is replaced with the uploaded URL when the
 * note is posted. `previewUrl` is an object URL for image/video thumbnails (null
 * for other file types) and must be revoked when the attachment is removed or
 * the note is cleared.
 */
export interface ComposeAttachment {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'file';
  placeholder: string;
  previewUrl: string | null;
  status: AttachmentStatus;
  error?: string;
  media?: UploadedMedia;
}

/** Coarse category used to decide how to render a placeholder. */
export function classifyAttachment(mimeType: string): ComposeAttachment['kind'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Build a staged attachment from a File. `placeholder` is the inline token the
 * component inserted at the cursor. `createPreview` is injected so the component
 * owns object-URL lifetime (and tests can skip URL.createObjectURL).
 */
export function createAttachment(
  file: File,
  id: string,
  placeholder: string,
  createPreview: (file: File) => string | null = () => null,
): ComposeAttachment {
  const mimeType = file.type || 'application/octet-stream';
  const kind = classifyAttachment(mimeType);
  return {
    id,
    file,
    name: file.name || 'attachment',
    mimeType,
    size: file.size,
    kind,
    placeholder,
    previewUrl: kind === 'image' || kind === 'video' ? createPreview(file) : null,
    status: 'pending',
  };
}

/**
 * The attachments still referenced by the note text — i.e. whose inline
 * placeholder survives in `content`. Files the user deleted from the note are
 * excluded, so their bytes are never handed to the upload service.
 */
export function activeAttachments(attachments: ComposeAttachment[], content: string): ComposeAttachment[] {
  return attachments.filter((attachment) => content.includes(attachment.placeholder));
}

/**
 * Upload one staged file through NAP-UPLOAD and return the attach-ready media.
 *
 * Thin seam over `upload.upload` so the component and unit tests share one path;
 * the injectable `uploader` lets tests mock the shell hook without a runtime.
 */
export async function uploadComposeFile(
  file: File,
  uploader: (request: { data: Blob; filename?: string; mimeType?: string; caption?: string }) => Promise<UploadResult> = (
    request,
  ) => upload.upload(request),
  caption?: string,
): Promise<UploadedMedia> {
  const result = await uploader({
    data: file,
    filename: file.name || undefined,
    mimeType: file.type || undefined,
    ...(caption ? { caption } : {}),
  });
  if (!result.ok || !result.url) {
    throw new Error(result.error ?? 'upload failed');
  }
  return {
    url: result.url,
    mimeType: result.mimeType,
    sha256: result.sha256,
    dimensions: result.dimensions,
    blurhash: result.blurhash,
    ...(caption ? { caption } : {}),
    nip94: result.nip94,
  };
}
