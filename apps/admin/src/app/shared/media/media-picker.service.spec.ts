import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_AUDIO_UPLOAD_BYTES,
  contentDoesNotMatchMessage,
  type AssetRef,
} from '@speakukrainian/shared';
import { MediaPickerService } from './media-picker.service';
import { NotificationService } from '../../core/notifications/notification.service';
import { environment } from '../../../environments/environment';

/**
 * Real leading bytes, because the picker now decides from them: an `'abc'`
 * fixture is refused before a request is opened, whatever it is named.
 */
const MP3_HEADER = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

const audioFile = (name = 'clip.mp3'): File => new File([MP3_HEADER], name, { type: 'audio/mpeg' });

/**
 * The picker reads the file's header before it opens the request, so nothing
 * reaches the HTTP mock until that read has settled.
 */
const untilRequestOpened = (): Promise<void> =>
  new Promise((resolve) => setTimeout(() => resolve(), 0));

const clip: AssetRef = {
  path: 'audio/2026/03/2f7d1f1c-0b3a-4b2e-9d31-8b5f0a1c2d3e.mp3',
  url: 'http://localhost:4443/storage/v1/b/bucket/o/audio%2Fclip.mp3?alt=media',
  contentType: 'audio/mpeg',
  sizeBytes: 3,
};

class RecordingNotifications {
  readonly errors: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }

  success(): void {
    /* unused by the picker */
  }

  info(): void {
    /* unused by the picker */
  }
}

describe('MediaPickerService', () => {
  let picker: MediaPickerService;
  let httpMock: HttpTestingController;
  let notifications: RecordingNotifications;

  const audioUrl = `${environment.apiBaseUrl}/media/audio`;

  beforeEach(() => {
    notifications = new RecordingNotifications();
    TestBed.configureTestingModule({
      providers: [
        MediaPickerService,
        { provide: NotificationService, useValue: notifications },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    picker = TestBed.inject(MediaPickerService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('uploads an allowed file and resolves with the stored asset', async () => {
    const file = audioFile();
    const uploaded = picker.uploadFile('audio', file);
    await untilRequestOpened();

    const req = httpMock.expectOne(audioUrl);
    // jsdom re-wraps the blob on `FormData.append`, so identity is not the
    // assertion available here.
    const sent = (req.request.body as FormData).get('file') as File;
    expect(sent.name).toBe('clip.mp3');
    expect(sent.type).toBe('audio/mpeg');
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(MP3_HEADER);
    req.flush(clip);

    await expect(uploaded).resolves.toEqual(clip);
    expect(notifications.errors).toEqual([]);
  });

  it('refuses a disallowed content type without opening a request', async () => {
    const file = new File(['abc'], 'notes.txt', { type: 'text/plain' });

    await expect(picker.uploadFile('audio', file)).resolves.toBeNull();

    httpMock.expectNone(audioUrl);
    expect(notifications.errors.join()).toContain('text/plain');
  });

  it('refuses an oversize file without opening a request, naming the limit', async () => {
    const file = audioFile('lecture.mp3');
    // Faked rather than allocated: the point is the size check, not 50 MB of
    // heap in a unit test.
    Object.defineProperty(file, 'size', { value: MAX_AUDIO_UPLOAD_BYTES + 1 });

    await expect(picker.uploadFile('audio', file)).resolves.toBeNull();

    httpMock.expectNone(audioUrl);
    expect(notifications.errors.join()).toContain('50 MB');
  });

  it('refuses a file whose bytes are not the type it declares, without opening a request', async () => {
    // `cp notes.txt notes.mp3`: the browser reads the type off the extension,
    // so only the header can tell the author what they actually picked.
    const file = new File(['this is text'], 'notes.mp3', { type: 'audio/mpeg' });

    await expect(picker.uploadFile('audio', file)).resolves.toBeNull();

    httpMock.expectNone(audioUrl);
    expect(notifications.errors).toEqual([contentDoesNotMatchMessage('audio', 'audio/mpeg')]);
  });

  it('refuses an image whose bytes are audio', async () => {
    const file = new File([MP3_HEADER], 'diagram.png', { type: 'image/png' });

    await expect(picker.uploadFile('image', file)).resolves.toBeNull();

    httpMock.expectNone(`${environment.apiBaseUrl}/media/image`);
    expect(notifications.errors.join()).toContain('image/png');
  });

  it('reports the format before the size when a file is both wrong and too big', async () => {
    const file = new File(['this is text'], 'lecture.mp3', { type: 'audio/mpeg' });
    Object.defineProperty(file, 'size', { value: MAX_AUDIO_UPLOAD_BYTES + 1 });

    await expect(picker.uploadFile('audio', file)).resolves.toBeNull();

    httpMock.expectNone(audioUrl);
    expect(notifications.errors).toEqual([contentDoesNotMatchMessage('audio', 'audio/mpeg')]);
    expect(notifications.errors.join()).not.toContain('50 MB');
  });

  it('stays quiet when the API already explained the rejection', async () => {
    const file = audioFile();
    const uploaded = picker.uploadFile('audio', file);
    await untilRequestOpened();

    httpMock
      .expectOne(audioUrl)
      .flush(
        { statusCode: 415, message: 'text/plain is not a supported audio format.' },
        { status: 415, statusText: 'Unsupported Media Type' },
      );

    await expect(uploaded).resolves.toBeNull();
    expect(notifications.errors).toEqual([]);
  });

  it('stays quiet for a 400 the interceptor already toasted', async () => {
    // The interceptor toasts the API's message for every status that is not
    // 401/403/5xx, not just 413 and 415, so a 400 must not double-toast either.
    const file = audioFile();
    const uploaded = picker.uploadFile('audio', file);
    await untilRequestOpened();

    httpMock
      .expectOne(audioUrl)
      .flush(
        { statusCode: 400, message: 'Too many files' },
        { status: 400, statusText: 'Bad Request' },
      );

    await expect(uploaded).resolves.toBeNull();
    expect(notifications.errors).toEqual([]);
  });

  it('reports a generic failure when the API gives no usable reason', async () => {
    const file = audioFile();
    const uploaded = picker.uploadFile('audio', file);
    await untilRequestOpened();

    httpMock
      .expectOne(audioUrl)
      .flush({ message: 'boom' }, { status: 500, statusText: 'Internal Server Error' });

    await expect(uploaded).resolves.toBeNull();
    expect(notifications.errors).toEqual(['Could not upload clip.mp3.']);
  });

  it('names the file when the connection drops, where no API message exists', async () => {
    // The interceptor can only show the transport error ("Failed to fetch"),
    // which says nothing about which of several uploads died — so the picker
    // must not treat a status 0 as already explained.
    const file = audioFile();
    const uploaded = picker.uploadFile('audio', file);
    await untilRequestOpened();

    httpMock
      .expectOne(audioUrl)
      .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

    await expect(uploaded).resolves.toBeNull();
    expect(notifications.errors).toEqual(['Could not upload clip.mp3.']);
  });

  it('names the file on a 403, where the interceptor only says "no permission"', async () => {
    const file = audioFile();
    const uploaded = picker.uploadFile('audio', file);
    await untilRequestOpened();

    httpMock
      .expectOne(audioUrl)
      .flush({ message: 'Requires one of: editor' }, { status: 403, statusText: 'Forbidden' });

    await expect(uploaded).resolves.toBeNull();
    expect(notifications.errors).toEqual(['Could not upload clip.mp3.']);
  });
});
