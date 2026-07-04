import { describe, expect, it, vi } from 'vitest';
import type { UploadResult } from '@napplet/sdk';
import { buildImetaTag, appendMediaUrls } from '@hyprgate/utils';
import {
  activeAttachments,
  classifyAttachment,
  createAttachment,
  uploadComposeFile,
} from './compose-uploads';

function fakeFile(name: string, type: string, size = 8): File {
  const file = new File([new Uint8Array(Math.min(size, 8))], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function uploadOk(overrides: Partial<UploadResult> = {}): UploadResult {
  return {
    ok: true,
    uploadId: 'u1',
    status: 'complete',
    rail: 'blossom',
    url: 'https://blossom.example/abc.png',
    sha256: 'a'.repeat(64),
    mimeType: 'image/png',
    nip94: [
      ['url', 'https://blossom.example/abc.png'],
      ['m', 'image/png'],
      ['x', 'a'.repeat(64)],
    ],
    ...overrides,
  };
}

describe('classifyAttachment', () => {
  it('buckets by mime prefix and defaults to file', () => {
    expect(classifyAttachment('image/png')).toBe('image');
    expect(classifyAttachment('video/mp4')).toBe('video');
    expect(classifyAttachment('audio/ogg')).toBe('audio');
    expect(classifyAttachment('application/pdf')).toBe('file');
  });
});

describe('createAttachment', () => {
  it('creates image previews but not previews for arbitrary files', () => {
    const preview = vi.fn(() => 'blob:preview');
    const img = createAttachment(fakeFile('a.png', 'image/png'), 'id1', '[📎 a.png]', preview);
    expect(img.kind).toBe('image');
    expect(img.previewUrl).toBe('blob:preview');
    expect(img.placeholder).toBe('[📎 a.png]');
    expect(img.status).toBe('pending');

    const doc = createAttachment(fakeFile('a.pdf', 'application/pdf'), 'id2', '[📎 a.pdf]', preview);
    expect(doc.kind).toBe('file');
    expect(doc.previewUrl).toBeNull();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('falls back to octet-stream and a name when the file has neither', () => {
    const att = createAttachment(fakeFile('', ''), 'id3', '[📎 file]');
    expect(att.mimeType).toBe('application/octet-stream');
    expect(att.name).toBe('attachment');
    expect(att.kind).toBe('file');
  });
});

describe('activeAttachments', () => {
  it('keeps only attachments whose inline placeholder is still in the note', () => {
    const kept = createAttachment(fakeFile('a.png', 'image/png'), 'id1', '[📎 a.png]');
    const removed = createAttachment(fakeFile('b.png', 'image/png'), 'id2', '[📎 b.png]');
    const content = 'look at [📎 a.png] — I deleted the other one';
    const active = activeAttachments([kept, removed], content);
    expect(active).toEqual([kept]);
    // The removed file is excluded, so it is never handed to the uploader.
    expect(active).not.toContain(removed);
  });
});

describe('uploadComposeFile', () => {
  it('hands the file blob to the shell and maps the result to UploadedMedia', async () => {
    const uploader = vi.fn(
      async (_request: { data: Blob; filename?: string; mimeType?: string; caption?: string }) =>
        uploadOk({ dimensions: { width: 10, height: 20 } }),
    );
    const media = await uploadComposeFile(fakeFile('a.png', 'image/png'), uploader, 'alt text');
    expect(uploader).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'a.png', mimeType: 'image/png', caption: 'alt text' }),
    );
    expect(uploader.mock.calls[0]![0].data).toBeInstanceOf(Blob);
    expect(media.url).toBe('https://blossom.example/abc.png');
    expect(media.dimensions).toEqual({ width: 10, height: 20 });
    expect(media.caption).toBe('alt text');
  });

  it('throws when the shell reports failure or omits a url', async () => {
    const failed = vi.fn(async (): Promise<UploadResult> => ({
      ok: false,
      uploadId: 'u1',
      status: 'failed',
      rail: 'blossom',
      error: 'server rejected',
    }));
    await expect(uploadComposeFile(fakeFile('a.png', 'image/png'), failed)).rejects.toThrow('server rejected');

    const noUrl = vi.fn(async () => uploadOk({ url: undefined }));
    await expect(uploadComposeFile(fakeFile('a.png', 'image/png'), noUrl)).rejects.toThrow();
  });

  it('produces an imeta tag and appended content the note can carry', async () => {
    const uploader = vi.fn(async () => uploadOk());
    const media = await uploadComposeFile(fakeFile('a.png', 'image/png'), uploader);
    expect(buildImetaTag(media)).toEqual([
      'imeta',
      'url https://blossom.example/abc.png',
      'm image/png',
      `x ${'a'.repeat(64)}`,
    ]);
    expect(appendMediaUrls('look', [media.url])).toBe('look\n\nhttps://blossom.example/abc.png');
  });
});
