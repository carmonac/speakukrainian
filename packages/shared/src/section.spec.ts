import { describe, expect, it } from 'vitest';
import {
  SECTION_ROOT_PARENT,
  createSectionSchema,
  editableSectionFields,
  listSectionsQuerySchema,
  sectionIdSchema,
  sectionSchema,
  updateSectionSchema,
} from './section.js';

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

const baseSection = {
  id: 'sec-1',
  parentId: null,
  ancestorIds: [],
  depth: 0,
  kind: 'content' as const,
  slug: 'grammar-points',
  path: '/grammar-points',
  title: { en: 'Grammar points' },
  showInMenu: true,
  sortOrder: 0,
  status: 'draft' as const,
  audit,
};

describe('sectionSchema', () => {
  it('accepts a root content section', () => {
    expect(sectionSchema.parse(baseSection).slug).toBe('grammar-points');
  });

  it('accepts a subsection whose depth matches its ancestors', () => {
    const result = sectionSchema.parse({
      ...baseSection,
      id: 'sec-2',
      parentId: 'sec-1',
      ancestorIds: ['sec-1'],
      depth: 1,
      slug: 'present-simple',
      path: '/grammar-points/present-simple',
    });
    expect(result.depth).toBe(1);
  });

  it('rejects a depth that disagrees with the ancestor chain', () => {
    // Guards against a re-parent that updates one field but not the other,
    // which would silently corrupt subtree queries.
    const result = sectionSchema.safeParse({
      ...baseSection,
      parentId: 'sec-1',
      ancestorIds: ['sec-1'],
      depth: 0,
    });
    expect(result.success).toBe(false);
  });

  it('requires a link target on a link section', () => {
    const result = sectionSchema.safeParse({ ...baseSection, kind: 'link' });
    expect(result.success).toBe(false);
  });

  it('rejects a link target on a content section', () => {
    const result = sectionSchema.safeParse({
      ...baseSection,
      kind: 'content',
      link: { type: 'external', href: 'https://example.com', openInNewTab: true },
    });
    expect(result.success).toBe(false);
  });

  it.each(['/grammar', '/', '/a/b/c'])('accepts %j as an internal link target', (href) => {
    const result = sectionSchema.safeParse({
      ...baseSection,
      kind: 'link',
      link: { type: 'internal', href },
    });
    expect(result.success).toBe(true);
  });

  it.each(['grammar', '//evil.com', 'https://x.test', 'javascript:alert(1)'])(
    'rejects %j as an internal link target, pathed to the href',
    (href) => {
      // `//evil.com` is the one that matters: a protocol-relative URL leaves the
      // site while passing for a path.
      const result = sectionSchema.safeParse({
        ...baseSection,
        kind: 'link',
        link: { type: 'internal', href },
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['link', 'href']);
    },
  );

  it.each(['https://example.com/x', 'http://a.test'])(
    'accepts %j as an external link target',
    (href) => {
      const result = sectionSchema.safeParse({
        ...baseSection,
        kind: 'link',
        link: { type: 'external', href },
      });
      expect(result.success).toBe(true);
    },
  );

  it.each(['/internal', 'javascript:alert(1)', 'ftp://x.test', 'not a url'])(
    'rejects %j as an external link target, pathed to the href',
    (href) => {
      const result = sectionSchema.safeParse({
        ...baseSection,
        kind: 'link',
        link: { type: 'external', href },
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['link', 'href']);
    },
  );

  it('rejects a slug that is not kebab-case', () => {
    expect(sectionSchema.safeParse({ ...baseSection, slug: 'Grammar Points' }).success).toBe(false);
  });

  it('defaults a stored document written before the flags existed', () => {
    const { showInMenu: _showInMenu, sortOrder: _sortOrder, status: _status, ...old } = baseSection;

    expect(sectionSchema.parse(old)).toMatchObject({
      showInMenu: false,
      sortOrder: 0,
      status: 'draft',
    });
  });
});

describe('createSectionSchema', () => {
  it('defaults a new section to a hidden root draft', () => {
    const result = createSectionSchema.parse({
      slug: 'listening',
      title: { en: 'Listening' },
    });
    expect(result).toEqual({
      parentId: null,
      kind: 'content',
      slug: 'listening',
      title: { en: 'Listening' },
      showInMenu: false,
      status: 'draft',
    });
  });

  it('leaves an omitted sortOrder absent so the repository can append', () => {
    const result = createSectionSchema.parse({ slug: 'listening', title: { en: 'Listening' } });

    expect(result.sortOrder).toBeUndefined();
  });

  it('refuses a null image, because a new section has nothing to clear', () => {
    const result = createSectionSchema.safeParse({
      slug: 'listening',
      title: { en: 'Listening' },
      image: null,
    });

    expect(result.success).toBe(false);
  });
});

describe('updateSectionSchema', () => {
  it('returns only the fields the request carried', () => {
    const parsed = updateSectionSchema.parse({ title: { en: 'Renamed' } });

    // The defaulted fields must not appear. A PATCH that reached the repository
    // with `status`, `showInMenu` and `kind` filled in would unpublish a live
    // section, drop it out of the menu and strip a link section's target — all
    // from an editor fixing a typo in the title.
    expect(parsed).toEqual({ title: { en: 'Renamed' } });
    expect(Object.keys(parsed)).toEqual(['title']);
  });

  it('leaves the other fields out of a slug-only rename patch', () => {
    const parsed = updateSectionSchema.parse({ slug: 'grammar' });

    expect(parsed).toEqual({ slug: 'grammar' });
    expect(Object.keys(parsed)).toEqual(['slug']);
  });

  it('accepts an empty patch without inventing any field', () => {
    expect(updateSectionSchema.parse({})).toEqual({});
  });

  it('keeps the values a full patch does carry', () => {
    const patch = {
      kind: 'link' as const,
      slug: 'external',
      title: { en: 'External' },
      description: { en: '<p>Body</p>' },
      showInMenu: true,
      menuLabel: { en: 'Ext' },
      link: { type: 'external' as const, href: 'https://example.com', openInNewTab: true },
      sortOrder: 7,
      status: 'published' as const,
    };

    expect(updateSectionSchema.parse(patch)).toEqual(patch);
  });

  it('strips a parentId, which only a move may change', () => {
    // Accepting it would re-parent a section without recomputing the paths of
    // its subtree, leaving every descendant on a URL that no longer resolves.
    expect(updateSectionSchema.parse({ parentId: 'AbC012defGHI345jklMN', slug: 'x' })).toEqual({
      slug: 'x',
    });
  });

  it('accepts null for image, which is how a stored image is cleared', () => {
    // An omitted field means "leave it alone", so removing an image needs a way
    // to say "clear it" that is not simply the absence of the key.
    expect(updateSectionSchema.parse({ image: null })).toEqual({ image: null });
  });

  it('still refuses null for a field that has no clearing meaning', () => {
    expect(updateSectionSchema.safeParse({ title: null }).success).toBe(false);
    expect(updateSectionSchema.safeParse({ slug: null }).success).toBe(false);
  });

  it('still applies the href shape rule after .partial()', () => {
    // `.partial()` is the route a PATCH body takes, and a rule that only held on
    // the create schema would let an edit store a target the reader cannot follow.
    const result = updateSectionSchema.safeParse({
      link: { type: 'external', href: 'nope' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['link', 'href']);
  });

  it('rejects an invalid value for a field it does carry', () => {
    expect(updateSectionSchema.safeParse({ status: 'nonsense' }).success).toBe(false);
    expect(updateSectionSchema.safeParse({ kind: 'redirect' }).success).toBe(false);
    expect(updateSectionSchema.safeParse({ slug: 'Not Kebab' }).success).toBe(false);
    expect(updateSectionSchema.safeParse({ sortOrder: 1.5 }).success).toBe(false);
  });
});

describe('editableSectionFields', () => {
  it('names only fields the stored document also has', () => {
    // A field that is patchable but not storable would be accepted by the API
    // and then dropped by `sectionSchema.parse()` in the repository — a write
    // that reports success and changes nothing.
    const stored = Object.keys(sectionSchema.shape);
    const unstorable = Object.keys(editableSectionFields).filter(
      (field) => !stored.includes(field),
    );

    expect(unstorable).toEqual([]);
  });
});

describe('sectionIdSchema', () => {
  it('accepts a Firestore auto-id', () => {
    expect(sectionIdSchema.parse('AbC012defGHI345jklMN')).toBe('AbC012defGHI345jklMN');
  });

  it.each(['..', 'a/b', '', 'a'.repeat(129), 'has space', 'dot.dot'])(
    'rejects %j as a document id',
    (candidate) => {
      // These reach `collection.doc()` straight from a URL segment: `..` and
      // `a/b` would address a different document entirely.
      expect(sectionIdSchema.safeParse(candidate).success).toBe(false);
    },
  );
});

describe('listSectionsQuerySchema', () => {
  it('defaults the page size and leaves both filters absent', () => {
    expect(listSectionsQuerySchema.parse({})).toEqual({ limit: 25 });
  });

  it('coerces the limit out of its query-string form', () => {
    expect(listSectionsQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('accepts the root sentinel as a parent filter', () => {
    expect(listSectionsQuerySchema.parse({ parentId: SECTION_ROOT_PARENT }).parentId).toBe('root');
  });

  it('accepts a real parent id', () => {
    expect(listSectionsQuerySchema.parse({ parentId: 'AbC012defGHI345jklMN' }).parentId).toBe(
      'AbC012defGHI345jklMN',
    );
  });

  it('rejects a status that is not a publish status', () => {
    expect(listSectionsQuerySchema.safeParse({ status: 'nonsense' }).success).toBe(false);
  });
});
