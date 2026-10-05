import { BadgeDevice } from './badge.js';
import { createBadgeFS } from './badge-fs.js';
import { setUserFSBackend } from '../fs.js';
import { currentMode } from '../mode.js';

export const badgeEvents = new EventTarget();

export const badgeDevice = currentMode() === 'badge' ? new BadgeDevice() : null;

export const badgeFS = badgeDevice
  ? createBadgeFS(badgeDevice, {
    onChange: () => badgeEvents.dispatchEvent(new Event('change')),
    onError: (error) => badgeEvents.dispatchEvent(new CustomEvent('error', { detail: error })),
  })
  : null;

if (badgeFS) setUserFSBackend(badgeFS);
