import { Component } from '@angular/core';

/**
 * Renders whatever section or page the URL resolves to. Replaced by the Phase 1
 * public-site issues, which add the content resolver and the per-page-type
 * renderers (rich text, subsection list, H5P exercise).
 */
@Component({
  selector: 'app-content-page',
  template: `
    <main>
      <p>Content rendering is not built yet.</p>
    </main>
  `,
})
export class ContentPage {}
