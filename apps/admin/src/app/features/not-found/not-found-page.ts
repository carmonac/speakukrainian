import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found-page',
  imports: [RouterLink],
  template: `
    <h1>Page not found</h1>
    <p><a routerLink="/sections">Back to sections</a></p>
  `,
})
export class NotFoundPage {}
