import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type CanActivateFn } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { navigationState } from './navigation-state';

@Component({ selector: 'app-blank', template: '' })
class Blank {}

let seenDuringNavigation: string | undefined;

/** Guards run while the navigation is still pending, which is the hard case. */
const capture: CanActivateFn = () => {
  seenDuringNavigation = navigationState<string>(inject(Router), 'savedCode');
  return true;
};

describe('navigationState', () => {
  beforeEach(() => {
    seenDuringNavigation = undefined;
    history.replaceState({}, '');
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'target', component: Blank, canActivate: [capture] }])],
    });
  });

  it('reads the state of a navigation that has not been written to history yet', async () => {
    await TestBed.inject(Router).navigate(['/target'], { state: { savedCode: 'uk' } });

    expect(seenDuringNavigation).toBe('uk');
  });

  it('falls back to history.state, which is all a refresh leaves behind', () => {
    history.replaceState({ savedCode: 'es' }, '');

    expect(navigationState<string>(TestBed.inject(Router), 'savedCode')).toBe('es');
  });

  it('prefers the pending navigation over the state left by the previous one', async () => {
    history.replaceState({ savedCode: 'stale' }, '');

    await TestBed.inject(Router).navigate(['/target'], { state: { savedCode: 'fresh' } });

    expect(seenDuringNavigation).toBe('fresh');
  });

  it('is undefined when neither source carries the key', async () => {
    await TestBed.inject(Router).navigate(['/target']);

    expect(seenDuringNavigation).toBeUndefined();
    expect(navigationState<string>(TestBed.inject(Router), 'savedCode')).toBeUndefined();
  });
});
