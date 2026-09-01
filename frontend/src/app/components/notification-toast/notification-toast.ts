import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { trigger, transition, style, animate } from '@angular/animations';
import { Subscription } from 'rxjs';
import { NotificationService, Notification } from '../../services/notification';

@Component({
  selector: 'notification-toast',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notification-toast.html',
  styleUrls: ['./notification-toast.scss'],
  animations: [
    trigger('slideIn', [
      transition(':enter', [
        style({ transform: 'translateX(100%)', opacity: 0 }),
        animate('300ms ease-out', style({ transform: 'translateX(0)', opacity: 1 }))
      ]),
      transition(':leave', [
        animate('200ms ease-in', style({ transform: 'translateX(100%)', opacity: 0 }))
      ])
    ])
  ]
})
export class NotificationToastComponent implements OnInit, OnDestroy {
  notifications: Notification[] = [];
  private subscription?: Subscription;
  private toastTimers: Map<string, any> = new Map();

  constructor(private notificationService: NotificationService) {}

  ngOnInit(): void {
    this.subscription = this.notificationService.toastNotifications$.subscribe(
      notification => {
        if (notification) {
          this.showToast(notification);
        }
      }
    );
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.toastTimers.forEach(timer => clearTimeout(timer));
  }

  private showToast(notification: Notification): void {
    // Add to notifications list
    this.notifications.push(notification);

    // Sticky errors accumulate (a batch of failed handoffs is one error EACH), and a
    // stack taller than the window puts the close buttons out of reach. Oldest goes
    // first — everything lives on in the bell's history either way.
    while (this.notifications.length > 5) {
      this.removeToast(this.notifications[0].id);
    }

    // An error stays until the operator closes it: it usually reports the end of
    // something that took a while, and a report that deletes itself in five seconds has
    // to be reproduced to be reread. Everything else auto-dismisses — warnings a little
    // slower than good news.
    if (notification.type === 'error') return;
    const timer = setTimeout(() => {
      this.removeToast(notification.id);
    }, notification.type === 'warning' ? 10000 : 5000);

    this.toastTimers.set(notification.id, timer);
  }

  removeToast(id: string): void {
    const index = this.notifications.findIndex(n => n.id === id);
    if (index !== -1) {
      this.notifications.splice(index, 1);
    }

    // Clear timer
    const timer = this.toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.toastTimers.delete(id);
    }
  }

  clickToast(notification: Notification): void {
    // Show modal with full details
    this.notificationService.showModal(notification);
    // Remove toast
    this.removeToast(notification.id);
  }

  getIcon(type: string): string {
    switch (type) {
      case 'success': return '✓';
      case 'error': return '✕';
      case 'warning': return '⚠';
      case 'info': return 'ℹ';
      default: return '•';
    }
  }
}
