import { TestBed } from '@angular/core/testing';
import {
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { errorInterceptor, showsApiMessage } from './error.interceptor';
import { NotificationService } from '../notifications/notification.service';

class RecordingNotifications {
  readonly errors: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }

  success(): void {
    /* unused here */
  }

  info(): void {
    /* unused here */
  }
}

class RecordingRouter {
  readonly navigations: { commands: unknown[]; state: unknown }[] = [];
  readonly url = '/locales/en';

  navigate(commands: unknown[], extras?: { state?: unknown }): Promise<boolean> {
    this.navigations.push({ commands, state: extras?.state });
    return Promise.resolve(true);
  }
}

describe('errorInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let notifications: RecordingNotifications;
  let router: RecordingRouter;

  /** Resolves once the failing request has settled, so the toast has been raised. */
  function failWith(status: number, body: object): Promise<HttpErrorResponse> {
    const settled = new Promise<HttpErrorResponse>((resolve) => {
      http.get('/anything').subscribe({ error: (error: HttpErrorResponse) => resolve(error) });
    });
    httpMock.expectOne('/anything').flush(body, { status, statusText: 'Failed' });
    return settled;
  }

  beforeEach(() => {
    notifications = new RecordingNotifications();
    router = new RecordingRouter();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: notifications },
        { provide: Router, useValue: router },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('sends an expired session to the login page carrying the return url', async () => {
    await failWith(401, { message: 'Missing bearer token' });

    expect(router.navigations).toEqual([
      { commands: ['/login'], state: { returnUrl: '/locales/en' } },
    ]);
    expect(notifications.errors).toEqual([]);
  });

  it('shows generic wording for 403 and 5xx, which name no cause', async () => {
    await failWith(403, { message: 'Requires one of: editor' });
    await failWith(500, { message: 'Cannot read properties of undefined' });

    expect(notifications.errors).toEqual([
      'You do not have permission to do that.',
      'Something went wrong on the server. Please try again.',
    ]);
    expect(router.navigations).toEqual([]);
  });

  it('shows the API message for every other status', async () => {
    await failWith(400, { message: 'Too many files' });
    await failWith(413, { message: 'Audio files must be under 50 MB.' });
    await failWith(415, { message: 'text/plain is not a supported audio format.' });

    expect(notifications.errors).toEqual([
      'Too many files',
      'Audio files must be under 50 MB.',
      'text/plain is not a supported audio format.',
    ]);
  });

  it('joins a validation error list rather than showing the envelope', async () => {
    await failWith(422, {
      errors: [{ message: 'code is required' }, { message: 'name too long' }],
    });

    expect(notifications.errors).toEqual(['code is required, name too long']);
  });

  it('re-throws so a caller can still react to the failure itself', async () => {
    const error = await failWith(415, { message: 'nope' });

    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect(error.status).toBe(415);
  });

  it('agrees with showsApiMessage about which toast the caller will see', () => {
    // The picker suppresses its own toast on `showsApiMessage`; if the
    // predicate and the branch above it ever disagreed, a rejection would be
    // either double-toasted or silent.
    for (const status of [400, 404, 413, 415, 422]) {
      expect(showsApiMessage(new HttpErrorResponse({ status }))).toBe(true);
    }
    for (const status of [401, 403, 500, 503]) {
      expect(showsApiMessage(new HttpErrorResponse({ status }))).toBe(false);
    }
  });
});
