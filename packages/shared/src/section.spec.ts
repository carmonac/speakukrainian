import { describe, expect, it } from 'vitest';
import { createSectionSchema, sectionSchema } from './section.js';

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

  it('rejects a slug that is not kebab-case', () => {
    expect(sectionSchema.safeParse({ ...baseSection, slug: 'Grammar Points' }).success).toBe(false);
  });
});

describe('createSectionSchema', () => {
  it('defaults a new section to a hidden root draft', () => {
    const result = createSectionSchema.parse({
      slug: 'listening',
      title: { en: 'Listening' },
    });
    expect(result).toMatchObject({
      parentId: null,
      kind: 'content',
      showInMenu: false,
      status: 'draft',
    });
  });
});
