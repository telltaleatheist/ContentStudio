// Runs on the scheduler's two extension pages, so connecting takes no pasting. The first page is
// a form that makes this browser a device key, reached only when signed in with Google; the
// second shows the key, which goes to the service worker, which stores it and closes the tab.

import { requestSaveSchedulerKey } from './scheduler/scheduler-messages';

const form = document.getElementById('cs-extension-connect');
if (form instanceof HTMLFormElement) form.requestSubmit();

const key = document.getElementById('cs-extension-key')?.textContent?.trim();
if (key) {
  requestSaveSchedulerKey(key).catch((error: unknown) => {
    console.error('[ContentStudio] the scheduler key could not be saved:', error);
  });
}
