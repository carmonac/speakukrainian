import { describe, expect, it } from 'vitest';
import { RichTextSanitizer } from './rich-text.sanitizer.js';

const sanitizer = new RichTextSanitizer();

describe('RichTextSanitizer', () => {
  it('drops a script element and the code inside it', () => {
    const clean = sanitizer.sanitize('<p>Hi</p><script>alert(1)</script>');

    expect(clean).toBe('<p>Hi</p>');
    expect(clean).not.toContain('alert');
  });

  it('keeps an audio node with every attribute the editor writes', () => {
    // The exact string `audio.extension.ts` renders. Audio is the product's
    // core content type (ADR-004); losing an attribute here silently breaks
    // playback or the storage reference behind the clip.
    const html =
      '<audio controls preload="metadata" src="https://cdn.test/a.mp3" data-asset-path="audio/2026/01/a.mp3"></audio>';

    const clean = sanitizer.sanitize(html);

    expect(clean).toContain('<audio');
    expect(clean).toContain('controls');
    expect(clean).toContain('preload="metadata"');
    expect(clean).toContain('src="https://cdn.test/a.mp3"');
    expect(clean).toContain('data-asset-path="audio/2026/01/a.mp3"');
  });

  it.each([
    ['an image', '<img src="https://cdn.test/x.png" alt="A diagram">'],
    [
      'a figure',
      '<figure><img src="https://cdn.test/x.png" alt="x"><figcaption>Cap</figcaption></figure>',
    ],
    ['a heading', '<h2>Present simple</h2>'],
    ['a list', '<ul><li>one</li><li>two</li></ul>'],
    ['a table', '<table><tbody><tr><td colspan="2">cell</td></tr></tbody></table>'],
    ['a link', '<a href="https://example.com" rel="noopener">Example</a>'],
  ])('keeps %s intact', (_name, html) => {
    expect(sanitizer.sanitize(html)).toBe(html);
  });

  it('strips a javascript: href but keeps the anchor', () => {
    const clean = sanitizer.sanitize('<a href="javascript:alert(1)">x</a>');

    expect(clean).toBe('<a>x</a>');
  });

  it('drops an inline event handler and keeps the element', () => {
    expect(sanitizer.sanitize('<p onclick="steal()">x</p>')).toBe('<p>x</p>');
  });

  it('drops onerror from an image', () => {
    const clean = sanitizer.sanitize('<img src="x" onerror="alert(1)">');

    expect(clean).toContain('src="x"');
    expect(clean).not.toContain('onerror');
  });

  it('drops a data attribute other than data-asset-path', () => {
    // Proves the one data attribute is allowed by name, not by pattern.
    expect(sanitizer.sanitize('<p data-evil="1">x</p>')).toBe('<p>x</p>');
  });

  it.each([
    ['a form', '<form><input name="x"></form>'],
    ['a style block', '<style>body { display: none }</style>'],
  ])('removes %s, which DOMPurify allows by default', (_name, html) => {
    const clean = sanitizer.sanitize(html);

    expect(clean).not.toContain('<form');
    expect(clean).not.toContain('<input');
    expect(clean).not.toContain('<style');
    expect(clean).not.toContain('display: none');
  });

  it('sanitizes every locale and keeps a locale that empties out', () => {
    const clean = sanitizer.sanitizeLocalized({ en: '<b>a</b><script>x</script>', uk: '' });

    expect(clean).toEqual({ en: 'a', uk: '' });
  });

  it('passes an absent value through untouched', () => {
    expect(sanitizer.sanitizeLocalized(undefined)).toBeUndefined();
  });

  it('is a fixed point on already-sanitized html', () => {
    // Every save re-sanitizes. A non-idempotent pass would escape the content
    // a little further on each edit until it renders as literal markup.
    const once = sanitizer.sanitize('<p>Tom &amp; Jerry</p><a href="https://x.test">link</a>');

    expect(sanitizer.sanitize(once)).toBe(once);
  });
});
