import { Node, mergeAttributes } from '@tiptap/core';

export interface AudioAttributes {
  src: string;
  title: string | null;
  /** Storage object path, kept so we can garbage-collect unreferenced uploads. */
  assetPath: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    audio: {
      setAudio: (attributes: AudioAttributes) => ReturnType;
    };
  }
}

/**
 * A block-level `<audio controls>` node.
 *
 * Audio is central to the learning content — pronunciation clips sit inline
 * with the text — so it is a first-class node rather than raw embedded HTML.
 * That keeps it selectable, deletable and serializable like any other block.
 */
export const Audio = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
      assetPath: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-asset-path'),
        renderHTML: (attributes) =>
          attributes['assetPath'] ? { 'data-asset-path': attributes['assetPath'] } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'audio[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['audio', mergeAttributes(HTMLAttributes, { controls: 'true', preload: 'metadata' })];
  },

  addCommands() {
    return {
      setAudio:
        (attributes: AudioAttributes) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attributes }),
    };
  },
});
