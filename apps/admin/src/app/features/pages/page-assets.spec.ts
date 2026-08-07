import { describe, expect, it } from 'vitest';
import type { AssetRef, RichTextPageBody } from '@speakukrainian/shared';
import { PageAssetTracker, referencedAssets } from './page-assets';

const CLIP: AssetRef = {
  path: 'audio/2026/01/hello.mp3',
  url: 'https://cdn.test/audio/2026/01/hello.mp3',
  contentType: 'audio/mpeg',
  sizeBytes: 12_345,
};

const OTHER_CLIP: AssetRef = {
  path: 'audio/2026/01/bye.mp3',
  url: 'https://cdn.test/audio/2026/01/bye.mp3',
  contentType: 'audio/mpeg',
  sizeBytes: 999,
};

const PICTURE: AssetRef = {
  path: 'images/2026/01/table.png',
  url: 'https://cdn.test/images/2026/01/table.png',
  contentType: 'image/png',
  sizeBytes: 4096,
};

function audioNode(asset: AssetRef): string {
  return `<audio src="${asset.url}" data-asset-path="${asset.path}" controls="true"></audio>`;
}

function imageNode(asset: AssetRef): string {
  return `<img src="${asset.url}" alt="">`;
}

function body(overrides: Partial<RichTextPageBody> = {}): RichTextPageBody {
  return { type: 'rich_text', content: {}, audioAssets: [], imageAssets: [], ...overrides };
}

describe('referencedAssets', () => {
  it('collects audio paths and image sources in document order', () => {
    const html = `<p>One</p>${audioNode(CLIP)}${imageNode(PICTURE)}${audioNode(OTHER_CLIP)}`;

    expect(referencedAssets(html)).toEqual({
      audioPaths: [CLIP.path, OTHER_CLIP.path],
      imageUrls: [PICTURE.url],
    });
  });

  it('ignores an audio element that carries no asset path of ours', () => {
    // Hand-pasted, or content written before the node existed. There is nothing
    // to record for it, and a null key reaching the registry would match every
    // other unknown clip.
    const html = '<audio src="https://elsewhere.test/x.mp3" controls="true"></audio>';

    expect(referencedAssets(html).audioPaths).toEqual([]);
  });

  it('answers with the src attribute exactly as written', () => {
    // The `.src` *property* is resolved against the document base, so jsdom and
    // a browser would both turn this into `http://localhost/images/a.png` and
    // it would match nothing the registry holds.
    expect(referencedAssets('<img src="images/a.png">').imageUrls).toEqual(['images/a.png']);
  });

  it('finds nothing in content with no assets at all', () => {
    expect(referencedAssets('<p>Just words</p>')).toEqual({ audioPaths: [], imageUrls: [] });
  });
});

describe('PageAssetTracker', () => {
  it('records an inserted asset and derives it back from the content', () => {
    const tracker = new PageAssetTracker();
    tracker.remember(CLIP);

    expect(tracker.derive({ uk: audioNode(CLIP) })).toEqual({
      audioAssets: [CLIP],
      imageAssets: [],
    });
  });

  it('routes an asset to the audio or the image map by its content type', () => {
    const tracker = new PageAssetTracker();
    tracker.remember(CLIP);
    tracker.remember(PICTURE);

    const derived = tracker.derive({ en: `${audioNode(CLIP)}${imageNode(PICTURE)}` });

    expect(derived.audioAssets).toEqual([CLIP]);
    expect(derived.imageAssets).toEqual([PICTURE]);
  });

  it('keeps one entry for a clip used twice in a locale', () => {
    const tracker = new PageAssetTracker();
    tracker.remember(CLIP);

    expect(tracker.derive({ en: `${audioNode(CLIP)}<p>and again</p>${audioNode(CLIP)}` })).toEqual({
      audioAssets: [CLIP],
      imageAssets: [],
    });
  });

  it('keeps one entry for a clip used in two locales', () => {
    const tracker = new PageAssetTracker();
    tracker.remember(CLIP);

    expect(tracker.derive({ en: audioNode(CLIP), uk: audioNode(CLIP) })).toEqual({
      audioAssets: [CLIP],
      imageAssets: [],
    });
  });

  it('drops a reference it cannot resolve and keeps the ones it can', () => {
    // Storing an invented content type and size would put a lie in the index;
    // the content still holds the reference either way.
    const tracker = new PageAssetTracker();
    tracker.remember(CLIP);

    expect(tracker.derive({ en: `${audioNode(CLIP)}${audioNode(OTHER_CLIP)}` })).toEqual({
      audioAssets: [CLIP],
      imageAssets: [],
    });
  });

  it('resolves a stored body’s own assets, so saving a title change keeps them', () => {
    // The regression this seeding exists for: without it, opening a page,
    // editing only the title and saving would post `audioAssets: []` and wipe
    // the index for every clip the author had inserted in an earlier session.
    const tracker = new PageAssetTracker();
    const stored = body({
      content: { uk: audioNode(CLIP) },
      audioAssets: [CLIP],
      imageAssets: [],
    });
    tracker.seed(stored);

    expect(tracker.derive(stored.content)).toEqual({ audioAssets: [CLIP], imageAssets: [] });
  });

  it('keeps assets from an earlier seed and from this session when seeded again', () => {
    // The shell re-patches the form after a save; a clearing seed would drop
    // the metadata of anything inserted since, which exists nowhere else.
    const tracker = new PageAssetTracker();
    tracker.seed(body({ audioAssets: [CLIP] }));
    tracker.remember(OTHER_CLIP);
    tracker.seed(body({ audioAssets: [CLIP] }));

    expect(
      tracker.derive({ en: `${audioNode(CLIP)}${audioNode(OTHER_CLIP)}` }).audioAssets,
    ).toEqual([CLIP, OTHER_CLIP]);
  });

  it('drops a clip the author deleted from the content, though it still remembers it', () => {
    const tracker = new PageAssetTracker();
    tracker.seed(body({ content: { uk: audioNode(CLIP) }, audioAssets: [CLIP] }));

    expect(tracker.derive({ uk: '<p>The clip is gone</p>' })).toEqual({
      audioAssets: [],
      imageAssets: [],
    });
    // Still remembered, so an undo — or a re-insert of the same clip — resolves.
    expect(tracker.derive({ uk: audioNode(CLIP) }).audioAssets).toEqual([CLIP]);
  });

  it('re-derives a locale after its HTML changes, memo or no memo', () => {
    const tracker = new PageAssetTracker();
    tracker.remember(CLIP);
    tracker.remember(OTHER_CLIP);

    expect(tracker.derive({ en: audioNode(CLIP) }).audioAssets).toEqual([CLIP]);
    expect(tracker.derive({ en: audioNode(OTHER_CLIP) }).audioAssets).toEqual([OTHER_CLIP]);
  });
});
