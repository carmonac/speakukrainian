import { Global, Module } from '@nestjs/common';
import { RichTextSanitizer } from './rich-text.sanitizer.js';

/**
 * Global because every content-bearing feature module sanitizes on write —
 * sections today, pages next — and none of them should have to re-provide it.
 */
@Global()
@Module({
  providers: [RichTextSanitizer],
  exports: [RichTextSanitizer],
})
export class CommonModule {}
