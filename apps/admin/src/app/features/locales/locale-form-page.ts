import { Component, computed, inject, input, signal, type OnInit } from '@angular/core';
import {
  FormBuilder,
  ReactiveFormsModule,
  Validators,
  type AbstractControl,
  type ValidationErrors,
  type ValidatorFn,
} from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
// The one value import of the shared barrel in the admin, and it sits inside a
// lazily-loaded route chunk. Copying the regex into `Validators.pattern` would
// be a second source of truth for the domain (rule 1).
import { localeCodeSchema, type Locale } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { DEFAULT_LOCALE_TOOLTIP } from './locale-messages';

export const localeCodeValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null =>
  localeCodeSchema.safeParse(control.value).success ? null : { localeCode: true };

@Component({
  selector: 'app-locale-form-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTooltipModule,
  ],
  templateUrl: './locale-form-page.html',
  styleUrl: './locale-form-page.scss',
})
export class LocaleFormPage implements OnInit {
  private readonly store = inject(LocalesStore);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  /** Bound by `withComponentInputBinding()`; absent on `/locales/new`. */
  readonly code = input<string>();

  protected readonly isEdit = computed(() => this.code() !== undefined);
  protected readonly saving = signal(false);
  /** Drives the same explanation the list gives, instead of a round trip to a 409. */
  protected readonly isDefault = signal(false);
  protected readonly defaultTooltip = DEFAULT_LOCALE_TOOLTIP;

  protected readonly form = this.fb.nonNullable.group({
    code: ['', [Validators.required, localeCodeValidator]],
    name: ['', Validators.required],
    nativeName: ['', Validators.required],
    direction: ['ltr' as Locale['direction'], Validators.required],
    enabled: [true],
    sortOrder: [0, Validators.required],
  });

  ngOnInit(): void {
    const code = this.code();
    if (code === undefined) {
      return;
    }

    // The shell resolver has already loaded the list, so a deep link that finds
    // nothing here is a deleted or mistyped code rather than a cold store.
    const existing = this.store.locales().find((locale) => locale.code === code);
    if (!existing) {
      this.notifications.error(`Locale "${code}" was not found.`);
      void this.router.navigate(['/locales']);
      return;
    }

    this.form.patchValue(existing);
    // The code is the document id and `updateLocaleSchema` omits it.
    this.form.controls.code.disable();

    this.isDefault.set(existing.isDefault);
    if (existing.isDefault) {
      // The API refuses to disable the default; offering the control here would
      // only ever produce a 409 and a form showing a state that was not saved.
      this.form.controls.enabled.disable();
    }
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.saving()) {
      return;
    }

    this.saving.set(true);
    const { code, name, nativeName, direction, enabled, sortOrder } = this.form.getRawValue();
    try {
      if (this.isEdit()) {
        await this.store.update(code, { name, nativeName, direction, enabled, sortOrder });
      } else {
        await this.store.create({ code, name, nativeName, direction, enabled, sortOrder });
      }
      await this.router.navigate(['/locales'], { state: { savedCode: code } });
    } catch {
      // Reported by the HTTP error interceptor.
    } finally {
      this.saving.set(false);
    }
  }
}
