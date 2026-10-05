import { BadgeDevice } from './badge.js';
import { createBadgeFS } from './badge-fs.js';
import { webSerialSupported } from '../mode.js';

export const badgeEvents = new EventTarget();

export const badgeDevice = webSerialSupported() ? new BadgeDevice() : null;

export const badgeFS = badgeDevice
  ? createBadgeFS(badgeDevice, {
    onChange: () => badgeEvents.dispatchEvent(new Event('change')),
    onError: (error) => badgeEvents.dispatchEvent(new CustomEvent('error', { detail: error })),
  })
  : null;
