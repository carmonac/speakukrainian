import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { AuthService } from '../core/auth/auth.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/sections', label: 'Sections', icon: 'account_tree' },
  { path: '/pages', label: 'Pages', icon: 'description' },
  { path: '/locales', label: 'Locales', icon: 'translate' },
  { path: '/schedule', label: 'Schedule slots', icon: 'event_available' },
  { path: '/media', label: 'Media', icon: 'perm_media' },
];

@Component({
  selector: 'app-admin-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatMenuModule,
    MatSidenavModule,
    MatToolbarModule,
  ],
  templateUrl: './admin-shell.html',
  styleUrl: './admin-shell.scss',
})
export class AdminShell {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly navItems = NAV_ITEMS;
  protected readonly sidenavOpen = signal(true);
  protected readonly user = this.auth.user;

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigate(['/login']);
  }
}
