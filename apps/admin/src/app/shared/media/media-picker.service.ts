import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  MEDIA_SIGNATURE_BYTES,
  MEDIA_UPLOAD_RULES,
  contentDoesNotMatchMessage,
  contentMatchesBytes,
  isAllowedContentType,
  mediaAcceptAttribute,
  unsupportedContentTypeMessage,
  uploadTooLargeMessage,
  type AssetRef,
  type MediaKind,
} from '@speakukrainian/shared';
import { ApiService } from '../../core/http/api.service';
import { showsApiMessage } from '../../core/http/error.interceptor';
import { NotificationService } from '../../core/notifications/notification.service';

/**
 * Supplies assets to the rich text editor and to image fields.
 *
 * Today this uploads straight from the user's disk. Browsing and reusing
 * already-uploaded assets is added by the media library feature, which will
 * swap the file input for a dialog behind these same two methods.
 */
@Injectable({ providedIn: 'root' })
export class MediaPickerService {
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);

  async pickImage(): Promise<AssetRef | null> {
    return this.pickAndUpload('image');
  }

  async pickAudio(): Promise<AssetRef | null> {
    return this.pickAndUpload('audio');
  }

  /** Returns the entered URL, `''` to clear an existing link, or `null` if cancelled. */
  async promptForUrl(current?: string): Promise<string | null> {
    return window.prompt('Link URL (leave empty to remove the link)', current ?? '');
  }

  /**
   * Uploads a file the caller already has. The type, the leading bytes and the
   * size are checked against the shared rules first, so an author who drags in
   * a 200 MB recording is told why without waiting for the upload the API would
   * refuse anyway.
   *
   * `file.type` is what the browser declares, and it derives that from the
   * extension: a text file renamed to `.mp3` reads as `audio/mpeg` here. Only
   * the header says what it really is, which is why the same
   * `contentMatchesBytes` the API applies runs here too — this one is the
   * courtesy, the API's is the guarantee.
   *
   * Bytes before size: reading 16 bytes of a 200 MB file costs nothing, and
   * "this is not an MP3" is more useful than "this is too big" when both are
   * true.
   */
  async uploadFile(kind: MediaKind, file: File): Promise<AssetRef | null> {
    if (!isAllowedContentType(kind, file.type)) {
      this.notifications.error(unsupportedContentTypeMessage(kind, file.type || 'unknown'));
      return null;
    }
    const declared = file.type;
    const header = new Uint8Array(await file.slice(0, MEDIA_SIGNATURE_BYTES).arrayBuffer());
    if (!contentMatchesBytes(declared, header)) {
      this.notifications.error(contentDoesNotMatchMessage(kind, declared));
      return null;
    }
    if (file.size > MEDIA_UPLOAD_RULES[kind].maxBytes) {
      this.notifications.error(uploadTooLargeMessage(kind));
      return null;
    }

    try {
      return await firstValueFrom(this.api.upload<AssetRef>(`/media/${kind}`, file));
    } catch (error) {
      // A rejection the API explained itself — 413 naming the limit, 415 listing
      // the allowed types — has already been toasted verbatim by the error
      // interceptor, and a generic toast on top would bury it. 403, 5xx and a
      // connection that never got a response get wording there that identifies
      // neither the file nor the reason, so naming the file adds something.
      if (!isAlreadyExplained(error)) {
        this.notifications.error(`Could not upload ${file.name}.`);
      }
      return null;
    }
  }

  private async pickAndUpload(kind: MediaKind): Promise<AssetRef | null> {
    const file = await selectFile(mediaAcceptAttribute(kind));
    return file ? this.uploadFile(kind, file) : null;
  }
}

function isAlreadyExplained(error: unknown): boolean {
  return error instanceof HttpErrorResponse && showsApiMessage(error);
}

/** Opens the OS file picker and resolves with the chosen file, or null if cancelled. */
function selectFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';

    // `cancel` fires in all current browsers; without it the promise would
    // dangle forever when the user dismisses the dialog.
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    });

    document.body.appendChild(input);
    input.click();
  });
}
