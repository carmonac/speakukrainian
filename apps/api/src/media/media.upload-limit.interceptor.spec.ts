import {
  ForbiddenException,
  HttpStatus,
  PayloadTooLargeException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  uploadTooLargeMessage,
  MAX_IMAGE_UPLOAD_BYTES,
  type MediaKind,
} from '@speakukrainian/shared';
import { UploadLimitInterceptor } from './media.upload-limit.interceptor.js';

const context = {} as unknown as ExecutionContext;

function handlerThrowing(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

async function run(kind: MediaKind, next: CallHandler): Promise<unknown> {
  return firstValueFrom(new UploadLimitInterceptor(kind).intercept(context, next));
}

/** Resolves with whatever the interceptor rejected with. */
async function rejection(kind: MediaKind, next: CallHandler): Promise<unknown> {
  try {
    await run(kind, next);
  } catch (error) {
    return error;
  }
  throw new Error('the interceptor let a failing upload through');
}

describe('UploadLimitInterceptor', () => {
  it('replaces multer bare 413 with a message naming the image limit', async () => {
    // `File too large` is what multer produces, and it never mentions 10 MB.
    const error = await rejection(
      'image',
      handlerThrowing(new PayloadTooLargeException('File too large')),
    );

    expect(error).toBeInstanceOf(PayloadTooLargeException);
    const exception = error as PayloadTooLargeException;
    expect(exception.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(exception.message).toBe('Images must be under 10 MB.');
    expect(exception.message).toBe(uploadTooLargeMessage('image'));
    expect(MAX_IMAGE_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('names the audio limit on the audio route', async () => {
    const error = await rejection(
      'audio',
      handlerThrowing(new PayloadTooLargeException('File too large')),
    );

    expect((error as PayloadTooLargeException).message).toBe('Audio files must be under 50 MB.');
  });

  it('passes any other failure through untouched', async () => {
    const original = new ForbiddenException('Requires one of: editor');

    expect(await rejection('image', handlerThrowing(original))).toBe(original);
  });

  it('passes a successful upload through untouched', async () => {
    const asset = { path: 'images/2026/03/a.png' };

    await expect(run('image', { handle: () => of(asset) })).resolves.toBe(asset);
  });
});
