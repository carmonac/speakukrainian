import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a handler argument against a Zod schema from `@speakukrainian/shared`.
 * Use it per-parameter so the schema stays visible at the call site:
 *
 * ```ts
 * @Post()
 * create(@Body(new ZodValidationPipe(createSectionSchema)) input: CreateSectionInput) {}
 * ```
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }
    return result.data;
  }
}
