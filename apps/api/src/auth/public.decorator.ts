import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as reachable without authentication — used by the public site. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
