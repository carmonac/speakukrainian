import {
  isAllowedContentType,
  type AssetRef,
  type RichText,
  type RichTextPageBody,
} from '@speakukrainian/shared';

/**
 * Which assets one locale's HTML refers to. Identity only — a storage path for
 * audio, a URL for an image — because that is all the saved content carries.
 */
export interface HtmlAssetRefs {
  audioPaths: string[];
  imageUrls: string[];
}

/** What a save writes into `body.audioAssets` and `body.imageAssets`. */
export interface DerivedAssets {
  audioAssets: AssetRef[];
  imageAssets: AssetRef[];
}

/**
 * The asset references in one locale's editor HTML, in document order.
 *
 * Parsing the serialized HTML rather than walking the tiptap document keeps this
 * independent of editor internals: the HTML is what is stored and what a future
 * orphan sweep would read back.
 */
export function referencedAssets(html: string): HtmlAssetRefs {
  // Constructed per call, never at module scope: the admin is browser-only, but
  // module-scope DOM access is the habit rule 6 is about.
  const document = new DOMParser().parseFromString(html, 'text/html');

  const audioPaths: string[] = [];
  // `audio[data-asset-path]`, not `audio`: content pasted by hand carries a
  // `src` and no path of ours, and there is nothing to record for it.
  for (const node of document.body.querySelectorAll('audio[data-asset-path]')) {
    const path = node.getAttribute('data-asset-path');
    if (path !== null && path !== '') {
      audioPaths.push(path);
    }
  }

  const imageUrls: string[] = [];
  for (const node of document.body.querySelectorAll('img[src]')) {
    // `getAttribute('src')`, not the `.src` property: the property is resolved
    // against the document base, so a relative `images/a.png` would come back
    // as an absolute URL that matches nothing the registry holds.
    const src = node.getAttribute('src');
    if (src !== null && src !== '') {
      imageUrls.push(src);
    }
  }

  return { audioPaths, imageUrls };
}

/**
 * Turns the asset references in a page's content into the `AssetRef`s the
 * schema wants.
 *
 * The split is deliberate: **the HTML decides which assets are referenced, and
 * this registry supplies what they are.** `assetRefSchema` needs `path`, `url`,
 * `contentType` and `sizeBytes`, and the saved content carries only a
 * `data-asset-path` or a `src` — the API sanitizer's `ALLOW_DATA_ATTR: false`
 * means no further `data-*` can be smuggled through. So the metadata comes from
 * the stored body ({@link seed}) and from the assets the picker returned this
 * session ({@link remember}).
 *
 * A reference the registry cannot resolve is **left out** rather than stored
 * with an invented content type and size. The arrays are an index over our own
 * uploads; the orphan sweep the data model describes reads `data-asset-path` out
 * of the content itself, so a missing entry loses nothing the HTML does not
 * still hold.
 */
export class PageAssetTracker {
  private readonly audioByPath = new Map<string, AssetRef>();
  private readonly imagesByUrl = new Map<string, AssetRef>();
  /**
   * One parse per locale, keyed on the exact HTML string, so a keystroke
   * re-parses only the locale being edited rather than every tab.
   */
  private readonly parsed = new Map<string, { html: string; refs: HtmlAssetRefs }>();

  /**
   * Fills the registry from a stored body. **Additive, never clearing**: a
   * second `writeValue` — the shell re-patching the form after a save — must not
   * lose the assets inserted this session, whose metadata exists nowhere else.
   */
  seed(body: RichTextPageBody | null): void {
    for (const asset of body?.audioAssets ?? []) {
      this.audioByPath.set(asset.path, asset);
    }
    for (const asset of body?.imageAssets ?? []) {
      this.imagesByUrl.set(asset.url, asset);
    }
  }

  /** An asset the picker just returned, classified by the rules it was uploaded under. */
  remember(asset: AssetRef): void {
    if (isAllowedContentType('audio', asset.contentType)) {
      this.audioByPath.set(asset.path, asset);
    } else {
      this.imagesByUrl.set(asset.url, asset);
    }
  }

  /**
   * The two arrays for the content as it stands, across every locale, first
   * occurrence kept.
   *
   * Deleting a node needs no special handling and gets none: this reads the
   * current HTML, so a clip that is no longer in the content is no longer in the
   * array on the next save. The registry keeps remembering it, which is what
   * makes an undo — or a re-insert of the same clip — resolve again.
   */
  derive(content: RichText): DerivedAssets {
    const audioAssets = new Map<string, AssetRef>();
    const imageAssets = new Map<string, AssetRef>();

    for (const [locale, html] of Object.entries(content)) {
      const refs = this.refsFor(locale, html);
      for (const path of refs.audioPaths) {
        const asset = this.audioByPath.get(path);
        if (asset !== undefined && !audioAssets.has(path)) {
          audioAssets.set(path, asset);
        }
      }
      for (const url of refs.imageUrls) {
        const asset = this.imagesByUrl.get(url);
        if (asset !== undefined && !imageAssets.has(url)) {
          imageAssets.set(url, asset);
        }
      }
    }

    return {
      audioAssets: [...audioAssets.values()],
      imageAssets: [...imageAssets.values()],
    };
  }

  private refsFor(locale: string, html: string): HtmlAssetRefs {
    const memo = this.parsed.get(locale);
    if (memo?.html === html) {
      return memo.refs;
    }
    const refs = referencedAssets(html);
    this.parsed.set(locale, { html, refs });
    return refs;
  }
}
