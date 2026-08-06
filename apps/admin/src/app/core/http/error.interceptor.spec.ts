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

  /** A request that never reached the API: no status, no body, no API message. */
  function failWithoutResponse(): Promise<HttpErrorResponse> {
    const settled = new Promise<HttpErrorResponse>((resolve) => {
      http.get('/anything').subscribe({ error: (error: HttpErrorResponse) => resolve(error) });
    });
    httpMock
      .expectOne('/anything')
      .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
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

  it('falls back to the transport error when the request got no response', async () => {
    const error = await failWithoutResponse();

    expect(error.status).toBe(0);
    // A dropped connection is not a server error and carries nothing the API
    // said, so the toast is Angular's own wording — which names neither the
    // cause nor the request. Naming the request is left to the caller, which
    // only does it while `showsApiMessage` is false.
    expect(notifications.errors).toEqual([error.message]);
    expect(showsApiMessage(error)).toBe(false);
    expect(router.navigations).toEqual([]);
  });

  it('re-throws so a caller can still react to the failure itself', async () => {
    const error = await failWith(415, { message: 'nope' });

    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect(error.status).toBe(415);
  });

  it('shows the API message exactly for the statuses showsApiMessage claims', async () => {
    // The picker suppresses its own toast on `showsApiMessage`, so the
    // predicate has to match what this interceptor actually toasts, not merely
    // restate its own terms: the two are compared here by driving the same
    // failure through both. Disagreement means a rejection is double-toasted or
    // silent. Status 0 is in the matrix because it is the one status where "no
    // 401/403/5xx" and "the API said something" come apart.
    const fromTheApi = 'the API explained this itself';
    const predicate: number[] = [];
    const toasted: number[] = [];

    for (const status of [0, 301, 400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503]) {
      notifications.errors.length = 0;
      const error =
        status === 0
          ? await failWithoutResponse()
          : await failWith(status, { message: fromTheApi });

      if (showsApiMessage(error)) predicate.push(status);
      if (notifications.errors.includes(fromTheApi)) toasted.push(status);
    }

    expect(toasted).toEqual(predicate);
    expect(predicate).not.toEqual([]);
  });
});
