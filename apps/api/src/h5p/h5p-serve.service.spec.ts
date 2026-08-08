import { Readable } from 'node:stream';
import { HttpException } from '@nestjs/common';
import { H5pError } from '@lumieducation/h5p-server';
import type { H5PAjaxEndpoint, H5PPlayer, IPlayerModel } from '@lumieducation/h5p-server';
import { describe, expect, it } from 'vitest';
import { H5pServeService } from './h5p-serve.service.js';

/** Just enough of a player model to tell "the renderer's value came back" from anything else. */
const MODEL = {
  contentId: 'abc',
  scripts: ['/api/h5p/core/js/h5p.js'],
  styles: [],
} as unknown as IPlayerModel;

type PlayerStub = Pick<H5PPlayer, 'render'>;
type AjaxStub = Pick<H5PAjaxEndpoint, 'getContentFile' | 'getLibraryFile'>;

interface Calls {
  rendered: string[];
  contentFiles: [contentId: string, filename: string][];
  libraryFiles: [ubername: string, filename: string][];
}

function createService(behaviour: {
  render?: () => Promise<unknown>;
  contentFile?: () => Promise<unknown>;
  libraryFile?: () => Promise<unknown>;
}): { service: H5pServeService; calls: Calls } {
  const calls: Calls = { rendered: [], contentFiles: [], libraryFiles: [] };

  const player: PlayerStub = {
    render: async (contentId) => {
      calls.rendered.push(String(contentId));
      return (behaviour.render ?? (() => Promise.resolve(MODEL)))();
    },
  };

  const ajax: AjaxStub = {
    getContentFile: async (contentId, filename, _user, getRange) => {
      calls.contentFiles.push([String(contentId), filename]);
      const result = await (
        behaviour.contentFile ??
        (() =>
          Promise.resolve({
            mimetype: 'audio/mpeg',
            range: getRange?.(4096),
            stats: { size: 4096, birthtime: new Date(0) },
            stream: Readable.from([Buffer.alloc(0)]),
          }))
      )();
      return result as Awaited<ReturnType<H5PAjaxEndpoint['getContentFile']>>;
    },
    getLibraryFile: async (ubername, filename) => {
      calls.libraryFiles.push([ubername, filename]);
      const result = await (
        behaviour.libraryFile ??
        (() =>
          Promise.resolve({
            mimetype: 'text/javascript',
            stats: { size: 12, birthtime: new Date(0) },
            stream: Readable.from([Buffer.from('window.x=1;')]),
          }))
      )();
      return result as Awaited<ReturnType<H5PAjaxEndpoint['getLibraryFile']>>;
    },
  };

  return {
    service: new H5pServeService(player as H5PPlayer, ajax as H5PAjaxEndpoint),
    calls,
  };
}

describe('playerModel', () => {
  it('returns what the renderer produced', async () => {
    const { service } = createService({});

    await expect(service.playerModel('abc')).resolves.toEqual(MODEL);
  });

  it('renders in the language it is given, and in English otherwise', async () => {
    const languages: (string | undefined)[] = [];
    const player: Pick<H5PPlayer, 'render'> = {
      render: async (_contentId, _user, language) => {
        languages.push(language);
        return MODEL;
      },
    };
    const service = new H5pServeService(player as H5PPlayer, {} as H5PAjaxEndpoint);

    await service.playerModel('abc');
    await service.playerModel('abc', 'uk');

    expect(languages).toEqual(['en', 'uk']);
  });

  it('answers an unknown id 404 with wording about the exercise, not about importing', async () => {
    // `H5PPlayer.render` raises exactly this for content it cannot load, so a
    // missing exercise needs no existence check of its own — only wording that
    // does not tell a reader their upload failed.
    const { service } = createService({
      render: () => Promise.reject(new H5pError('h5p-player:content-missing', {}, 404)),
    });

    const error = await service.playerModel('abc').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
    expect(JSON.stringify((error as HttpException).getResponse())).toContain(
      'That exercise does not exist.',
    );
  });

  it('refuses an unusable content id before the player is reached', async () => {
    const { service, calls } = createService({});

    await expect(service.playerModel('../../etc/passwd')).rejects.toBeInstanceOf(HttpException);
    // The proof that the guard is *in the path*: the player never saw the id,
    // so nothing further down had to be relied on to refuse it.
    expect(calls.rendered).toEqual([]);
  });

  it('lets a storage outage stay a 500 rather than blaming the request', async () => {
    const { service } = createService({
      render: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.1:443')),
    });

    const error = await service.playerModel('abc').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpException);
  });
});

describe('contentFile', () => {
  it('passes the range callback through and reports what it resolved to', async () => {
    const { service, calls } = createService({});

    const file = await service.contentFile('abc', 'media/tone.mp3', (size) => ({
      start: 10,
      end: size - 1,
    }));

    expect(calls.contentFiles).toEqual([['abc', 'media/tone.mp3']]);
    expect(file.range).toEqual({ start: 10, end: 4095 });
    // The whole object's size, which is what `Content-Range` reports after the
    // slash — not the length of the slice.
    expect(file.totalLength).toBe(4096);
    expect(file.mimetype).toBe('audio/mpeg');
  });

  it('reports no range when the request asked for none', async () => {
    const { service } = createService({});

    const file = await service.contentFile('abc', 'media/tone.mp3', () => undefined);

    expect(file.range).toBeUndefined();
    expect(file.totalLength).toBe(4096);
  });

  it('answers a missing file 404 with wording about the exercise', async () => {
    const { service } = createService({
      contentFile: () => Promise.reject(new H5pError('content-file-missing', {}, 404)),
    });

    const error = await service
      .contentFile('abc', 'media/none.mp3', () => undefined)
      .catch((thrown: unknown) => thrown);

    expect((error as HttpException).getStatus()).toBe(404);
    expect(JSON.stringify((error as HttpException).getResponse())).toContain(
      'That file is not part of this exercise.',
    );
  });

  it('refuses an unusable content id before the endpoint is reached', async () => {
    const { service, calls } = createService({});

    await expect(
      service.contentFile('../other', 'h5p.json', () => undefined),
    ).rejects.toBeInstanceOf(HttpException);
    expect(calls.contentFiles).toEqual([]);
  });
});

describe('libraryFile', () => {
  it('returns the stream, its mimetype and its length', async () => {
    const { service, calls } = createService({});

    const file = await service.libraryFile('SpeakTest.Main-1.0', 'main.js');

    expect(calls.libraryFiles).toEqual([['SpeakTest.Main-1.0', 'main.js']]);
    expect(file.mimetype).toBe('text/javascript');
    expect(file.contentLength).toBe(12);
  });

  it('answers a malformed ubername 400 with wording about library names', async () => {
    // `LibraryName.fromUberName` raises this from inside the endpoint, so the
    // route needs no pattern of its own.
    const { service } = createService({
      libraryFile: () =>
        Promise.reject(new H5pError('invalid-ubername-pattern', { name: 'nope' }, 400)),
    });

    const error = await service.libraryFile('nope', 'x.js').catch((thrown: unknown) => thrown);

    expect((error as HttpException).getStatus()).toBe(400);
    expect(JSON.stringify((error as HttpException).getResponse())).toContain(
      'That is not a valid H5P library name.',
    );
  });
});
