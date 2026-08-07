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
  MAX_H5P_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
  h5pUploadTooLargeMessage,
  uploadTooLargeMessage,
} from '@speakukrainian/shared';
import { UploadLimitInterceptor } from './upload-limit.interceptor.js';

const context = {} as unknown as ExecutionContext;

function handlerThrowing(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

async function run(message: string, next: CallHandler): Promise<unknown> {
  return firstValueFrom(new UploadLimitInterceptor(message).intercept(context, next));
}

/** Resolves with whatever the interceptor rejected with. */
async function rejection(message: string, next: CallHandler): Promise<unknown> {
  try {
    await run(message, next);
  } catch (error) {
    return error;
  }
  throw new Error('the interceptor let a failing upload through');
}

describe('UploadLimitInterceptor', () => {
  it('replaces multer bare 413 with a message naming the image limit', async () => {
    // `File too large` is what multer produces, and it never mentions 10 MB.
    const error = await rejection(
      uploadTooLargeMessage('image'),
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
      uploadTooLargeMessage('audio'),
      handlerThrowing(new PayloadTooLargeException('File too large')),
    );

    expect((error as PayloadTooLargeException).message).toBe('Audio files must be under 50 MB.');
  });

  it('carries wording that is not about media at all', async () => {
    // The interceptor moved out of `media/` because the limit it names is the
    // route's, not a media kind's; H5P is the first non-media caller.
    const error = await rejection(
      h5pUploadTooLargeMessage(),
      handlerThrowing(new PayloadTooLargeException('File too large')),
    );

    expect((error as PayloadTooLargeException).message).toBe('H5P packages must be under 100 MB.');
    expect(MAX_H5P_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });

  it('passes any other failure through untouched', async () => {
    const original = new ForbiddenException('Requires one of: editor');

    expect(await rejection('unused', handlerThrowing(original))).toBe(original);
  });

  it('passes a successful upload through untouched', async () => {
    const asset = { path: 'images/2026/03/a.png' };

    await expect(run('unused', { handle: () => of(asset) })).resolves.toBe(asset);
  });
});
