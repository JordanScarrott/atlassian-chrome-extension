// Bitbucket PR Tracker Service Worker (Manifest V3 background.js)

const ALARM_NAME = 'pollPRs';
const ALARM_INTERVAL_MINS = 5;

// Set up alarm and initial sync on installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('Bitbucket PR Tracker Extension Installed.');
  setupAlarm();
  fetchAndSyncPRs();
});

// Listen for alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('Alarm triggered: Polling Bitbucket PRs...');
    fetchAndSyncPRs();
  }
});

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REFRESH_PRS') {
    console.log('Manual refresh requested via message.');
    fetchAndSyncPRs()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for asynchronous response
  }
});

// Setup the alarms timer
function setupAlarm() {
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_INTERVAL_MINS });
    console.log(`Alarm scheduled for every ${ALARM_INTERVAL_MINS} minutes.`);
  });
}

// Main logic to fetch and sync Pull Requests
async function fetchAndSyncPRs() {
  try {
    const settings = await chrome.storage.local.get([
      'bitbucketToken',
      'bitbucketUsername',
      'authType'
    ]);

    const { bitbucketToken, bitbucketUsername, authType } = settings;

    if (!bitbucketToken) {
      console.log('No Bitbucket token/password configured. Clearing badge.');
      chrome.action.setBadgeText({ text: '' });
      await chrome.storage.local.set({ prList: [], error: 'Token not configured' });
      return;
    }

    // Determine auth header type
    let authHeader = '';
    if (authType === 'app_password') {
      if (!bitbucketUsername) {
        throw new Error('Username is required for App Password authentication.');
      }
      const credentials = `${bitbucketUsername.trim()}:${bitbucketToken.trim()}`;
      // In Manifest V3 service workers, btoa is natively supported
      const base64Credentials = btoa(unescape(encodeURIComponent(credentials)));
      authHeader = `Basic ${base64Credentials}`;
    } else {
      // Default to Personal Access Token / Bearer token
      authHeader = `Bearer ${bitbucketToken.trim()}`;
    }

    const headers = {
      'Authorization': authHeader,
      'Accept': 'application/json'
    };

    // 1. Fetch current user info to obtain uuid
    console.log('Fetching user info from Bitbucket...');
    const userResponse = await fetch('https://api.bitbucket.org/2.0/user', { headers });

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      throw new Error(`User API Failed (${userResponse.status}): ${errorText || userResponse.statusText}`);
    }

    const userData = await userResponse.json();
    const userUuid = userData.uuid;
    if (!userUuid) {
      throw new Error('Could not retrieve user UUID from Bitbucket API response.');
    }

    console.log(`Successfully obtained user UUID: ${userUuid}`);

    // 2. Fetch open pull requests associated with the user
    // Format is GET https://api.bitbucket.org/2.0/pullrequests/{uuid}?q=state="OPEN"
    const prUrl = `https://api.bitbucket.org/2.0/pullrequests/${encodeURIComponent(userUuid)}?q=state=%22OPEN%22`;
    console.log(`Fetching open pull requests...`);
    const prResponse = await fetch(prUrl, { headers });

    if (!prResponse.ok) {
      const errorText = await prResponse.text();
      throw new Error(`PR API Failed (${prResponse.status}): ${errorText || prResponse.statusText}`);
    }

    const prData = await prResponse.json();
    const rawPrList = prData.values || [];

    // Map response to clean structure for caching and popup display
    const mappedPrList = rawPrList.map((pr) => ({
      id: pr.id,
      title: pr.title,
      description: pr.description || '',
      state: pr.state,
      createdOn: pr.created_on,
      url: pr.links?.html?.href || '#',
      repoName: pr.source?.repository?.full_name || pr.destination?.repository?.full_name || 'Unknown Repository',
      author: pr.author?.display_name || 'Unknown Author'
    }));

    // Update the extension badge icon
    const prCount = mappedPrList.length;
    if (prCount > 0) {
      chrome.action.setBadgeText({ text: prCount.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#0052CC' }); // Atlassian Blue
    } else {
      chrome.action.setBadgeText({ text: '' });
    }

    // Save successful fetch results in local storage
    await chrome.storage.local.set({
      prList: mappedPrList,
      lastUpdated: Date.now(),
      error: null
    });

    console.log(`PR Sync completed successfully. Found ${prCount} open PR(s).`);

  } catch (error) {
    console.error('Error syncing Bitbucket PRs:', error);

    // Update badge to display error
    chrome.action.setBadgeText({ text: 'ERR' });
    chrome.action.setBadgeBackgroundColor({ color: '#DE350B' }); // Atlassian Red

    // Save error details in local storage
    await chrome.storage.local.set({
      error: error.message || 'An unknown error occurred during sync.'
    });
  }
}
