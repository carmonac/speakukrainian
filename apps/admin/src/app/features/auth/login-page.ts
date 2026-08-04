import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-login-page',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
  ],
  templateUrl: './login-page.html',
  styleUrl: './login-page.scss',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly submitting = signal(false);
  /** Seeded from the guard's explanation when a signed-in user was refused. */
  protected readonly errorMessage = signal<string | null>(this.navState<string>('message') ?? null);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  /**
   * Where to go after a successful sign-in. The auth guard puts the blocked URL
   * in `history.state`, so a deep link survives the detour through login — and
   * survives a refresh of the login page too, since the browser retains it.
   */
  private readonly returnUrl: string = this.navState<string>('returnUrl') ?? '/sections';

  /**
   * Reads a value a guard passed with `RedirectCommand`. During the redirect it
   * is only on the pending navigation; after a refresh the browser still has it
   * in `history.state`.
   */
  private navState<T>(key: string): T | undefined {
    return (
      (this.router.getCurrentNavigation()?.extras.state?.[key] as T | undefined) ??
      (history.state?.[key] as T | undefined)
    );
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.submitting()) {
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);

    const { email, password } = this.form.getRawValue();
    try {
      await this.auth.signIn(email, password);
      await this.router.navigateByUrl(this.returnUrl);
    } catch {
      this.errorMessage.set('That email and password combination was not recognised.');
    } finally {
      this.submitting.set(false);
    }
  }
}
