import { SetMetadata } from '@nestjs/common';

export const H5P_URL_TOKEN_KEY = 'h5pUrlToken';

/**
 * Marks a route that accepts the H5P URL credential **in addition to** a bearer
 * header, because Joubel's editor client sends no `Authorization` header.
 *
 * It changes only *how the caller is identified*. It never replaces the route's
 * `@Roles(...)`, it is not `@Public()`, and a request that carries neither
 * credential is still refused — `H5pUrlTokenGuard` returns without touching the
 * request when no token is present, and `FirebaseAuthGuard` then does its usual
 * job.
 */
export const H5pUrlToken = () => SetMetadata(H5P_URL_TOKEN_KEY, true);
