import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  it('creates the root component', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();

    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });
});

describe('routes', () => {
  it('routes the site root to the home page', () => {
    expect(routes.some((r) => r.path === '' && r.pathMatch === 'full')).toBe(true);
  });

  it('nests content under a locale segment', () => {
    // Every public URL carries its locale, so a shared link keeps its language.
    const localeRoute = routes.find((r) => r.path === ':localeCode');
    expect(localeRoute?.children?.some((c) => c.path === '**')).toBe(true);
  });
});
