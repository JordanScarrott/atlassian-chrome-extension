import { POLL_ALARM_NAME, createWorkerService } from './src/worker-service.js';

const worker = createWorkerService();

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await worker.ensurePollingAlarm();
    await worker.refreshBadgeFromStorage();
    await worker.syncNow({ forceManual: false });
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await worker.ensurePollingAlarm();
    await worker.refreshBadgeFromStorage();
    await worker.syncNow({ forceManual: false });
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    void worker.syncNow({ forceManual: false });
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  void worker.handleNotificationClick(notificationId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  worker.handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err instanceof Error && err.message ? err.message : 'Unexpected service worker error.'
      });
    });
  return true;
});
