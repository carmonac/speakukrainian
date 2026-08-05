import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_AUDIO_UPLOAD_BYTES, type AssetRef } from '@speakukrainian/shared';
import { MediaPickerService } from './media-picker.service';
import { NotificationService } from '../../core/notifications/notification.service';
import { environment } from '../../../environments/environment';

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
    const file = new File(['abc'], 'clip.mp3', { type: 'audio/mpeg' });
    const uploaded = picker.uploadFile('audio', file);

    const req = httpMock.expectOne(audioUrl);
    // jsdom re-wraps the blob on `FormData.append`, so identity is not the
    // assertion available here.
    const sent = (req.request.body as FormData).get('file') as File;
    expect(sent.name).toBe('clip.mp3');
    expect(sent.type).toBe('audio/mpeg');
    expect(await sent.text()).toBe('abc');
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
    const file = new File(['abc'], 'lecture.mp3', { type: 'audio/mpeg' });
    // Faked rather than allocated: the point is the size check, not 50 MB of
    // heap in a unit test.
    Object.defineProperty(file, 'size', { value: MAX_AUDIO_UPLOAD_BYTES + 1 });

    await expect(picker.uploadFile('audio', file)).resolves.toBeNull();

    httpMock.expectNone(audioUrl);
    expect(notifications.errors.join()).toContain('50 MB');
  });

  it('stays quiet when the API already explained the rejection', async () => {
    const file = new File(['abc'], 'clip.mp3', { type: 'audio/mpeg' });
    const uploaded = picker.uploadFile('audio', file);

    httpMock
      .expectOne(audioUrl)
      .flush(
        { statusCode: 415, message: 'text/plain is not a supported audio format.' },
        { status: 415, statusText: 'Unsupported Media Type' },
      );

    await expect(uploaded).resolves.toBeNull();
    expect(notifications.errors).toEqual([]);
  });

  it('reports a generic failure when the API gives no usable reason', async () => {
    const file = new File(['abc'], 'clip.mp3', { type: 'audio/mpeg' });
    const uploaded = picker.uploadFile('audio', file);

    httpMock
      .expectOne(audioUrl)
      .flush({ message: 'boom' }, { status: 500, statusText: 'Internal Server Error' });

    await expect(uploaded).resolves.toBeNull();
    expect(notifications.errors).toEqual(['Could not upload clip.mp3.']);
  });
});
