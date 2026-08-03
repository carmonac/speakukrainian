import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AssetRef } from '@speakukrainian/shared';
import { ApiService } from '../../core/http/api.service';
import { NotificationService } from '../../core/notifications/notification.service';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
const AUDIO_ACCEPT = 'audio/mpeg,audio/mp4,audio/ogg,audio/wav,audio/webm';

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
    return this.pickAndUpload(IMAGE_ACCEPT, 'image');
  }

  async pickAudio(): Promise<AssetRef | null> {
    return this.pickAndUpload(AUDIO_ACCEPT, 'audio');
  }

  /** Returns the entered URL, `''` to clear an existing link, or `null` if cancelled. */
  async promptForUrl(current?: string): Promise<string | null> {
    return window.prompt('Link URL (leave empty to remove the link)', current ?? '');
  }

  private async pickAndUpload(accept: string, kind: 'image' | 'audio'): Promise<AssetRef | null> {
    const file = await selectFile(accept);
    if (!file) {
      return null;
    }

    try {
      return await firstValueFrom(this.api.upload<AssetRef>(`/media/${kind}`, file));
    } catch {
      // The error interceptor already surfaced the reason.
      this.notifications.error(`Could not upload ${file.name}.`);
      return null;
    }
  }
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
