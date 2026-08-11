// Atlassian Extension Hub Popup JS

document.addEventListener('DOMContentLoaded', async () => {
  // --- Tab Navigation Setup ---
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  const appTitle = document.getElementById('app-title');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      // Deactivate all tabs
      tabButtons.forEach((t) => t.classList.remove('active'));
      // Hide all panels
      tabPanels.forEach((p) => p.classList.add('hidden'));

      // Activate clicked tab
      btn.classList.add('active');
      const targetPanelId = `${btn.getAttribute('data-tab')}-panel`;
      document.getElementById(targetPanelId).classList.remove('hidden');

      // Update app title text based on active tab
      if (btn.getAttribute('data-tab') === 'bitbucket-tab') {
        appTitle.textContent = 'Atlassian Hub';
      } else if (btn.getAttribute('data-tab') === 'jira-tab') {
        appTitle.textContent = 'Jira Hub';
      } else if (btn.getAttribute('data-tab') === 'confluence-tab') {
        appTitle.textContent = 'Confluence Hub';
      } else {
        appTitle.textContent = 'Customizer';
      }
    });
  });

  // --- Dynamic Form Add Product Request ---
  const addProductForm = document.getElementById('add-product-form');
  const productRequestSuccessAlert = document.getElementById('product-request-success');

  addProductForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const checkedProducts = Array.from(addProductForm.querySelectorAll('input[name="products"]:checked')).map(cb => cb.value);
    const feedback = document.getElementById('custom-product-feedback').value.trim();

    // Store custom requests securely in chrome.storage.local
    await chrome.storage.local.set({
      requestedProducts: checkedProducts,
      productFeedback: feedback,
      productFeedbackTimestamp: Date.now()
    });

    // Show success confirmation message
    productRequestSuccessAlert.classList.remove('hidden');
    setTimeout(() => {
      productRequestSuccessAlert.classList.add('hidden');
    }, 4000);
  });

  // --- Connection Settings DOM Elements ---
  const toggleSettingsBtn = document.getElementById('toggle-settings-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const authTypeSelect = document.getElementById('auth-type');
  const usernameGroup = document.getElementById('username-group');
  const bitbucketUsernameInput = document.getElementById('bitbucket-username');
  const tokenLabel = document.getElementById('token-label');
  const bitbucketTokenInput = document.getElementById('bitbucket-token');
  const toggleTokenVisibilityBtn = document.getElementById('toggle-token-visibility');
  const tokenHelpText = document.getElementById('token-help');
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  const cancelSettingsBtn = document.getElementById('cancel-settings-btn');

  const manualRefreshBtn = document.getElementById('manual-refresh-btn');
  const prCountTitle = document.getElementById('pr-count-title');
  const loadingIndicator = document.getElementById('loading-indicator');
  const errorAlert = document.getElementById('error-alert');
  const errorTitle = document.getElementById('error-title');
  const errorMessage = document.getElementById('error-message');
  const errorSetupBtn = document.getElementById('error-setup-btn');

  const prItemsContainer = document.getElementById('pr-items-container');
  const emptyState = document.getElementById('empty-state');
  const setupHint = document.getElementById('setup-hint');
  const setupHintBtn = document.getElementById('setup-hint-btn');

  const lastUpdatedText = document.getElementById('last-updated-text');

  // Load existing credentials and list on popup open
  await initializePopup();

  // Event Listeners for settings and syncing
  toggleSettingsBtn.addEventListener('click', toggleSettingsPanel);
  cancelSettingsBtn.addEventListener('click', hideSettingsPanel);
  authTypeSelect.addEventListener('change', handleAuthTypeChange);
  toggleTokenVisibilityBtn.addEventListener('click', toggleTokenVisibility);
  saveSettingsBtn.addEventListener('click', saveSettings);
  manualRefreshBtn.addEventListener('click', triggerManualSync);
  errorSetupBtn.addEventListener('click', showSettingsPanel);
  setupHintBtn.addEventListener('click', showSettingsPanel);

  // Initialize and load UI State
  async function initializePopup() {
    const data = await chrome.storage.local.get([
      'bitbucketToken',
      'bitbucketUsername',
      'authType',
      'prList',
      'lastUpdated',
      'error',
      'requestedProducts',
      'productFeedback'
    ]);

    // Populate Settings fields
    if (data.authType) {
      authTypeSelect.value = data.authType;
    } else {
      authTypeSelect.value = 'pat';
    }
    handleAuthTypeChange(); // align labels and visibility

    if (data.bitbucketUsername) {
      bitbucketUsernameInput.value = data.bitbucketUsername;
    }
    if (data.bitbucketToken) {
      bitbucketTokenInput.value = data.bitbucketToken;
    }

    // Populate requested products checkboxes if they were saved before
    if (data.requestedProducts) {
      data.requestedProducts.forEach((val) => {
        const checkbox = addProductForm.querySelector(`input[name="products"][value="${val}"]`);
        if (checkbox) checkbox.checked = true;
      });
    }
    if (data.productFeedback) {
      document.getElementById('custom-product-feedback').value = data.productFeedback;
    }

    // Load list or show configured states
    updateUI(data);
  }

  // Handle Authentication dropdown changes
  function handleAuthTypeChange() {
    const selectedType = authTypeSelect.value;
    if (selectedType === 'app_password') {
      usernameGroup.classList.remove('hidden');
      tokenLabel.textContent = 'App Password';
      bitbucketTokenInput.placeholder = 'Paste secure App Password here';
      tokenHelpText.textContent = "Requires 'Pull Requests: Read' and 'Repositories: Read' scopes. Use with your Bitbucket username.";
    } else {
      usernameGroup.classList.add('hidden');
      tokenLabel.textContent = 'Personal Access Token (PAT)';
      bitbucketTokenInput.placeholder = 'Paste secure Bearer token here';
      tokenHelpText.textContent = "Requires 'Pull Requests: Read' and 'Repositories: Read' scopes. Username is not required.";
    }
  }

  // Toggle Settings panel visibility
  function toggleSettingsPanel() {
    if (settingsPanel.classList.contains('hidden')) {
      showSettingsPanel();
    } else {
      hideSettingsPanel();
    }
  }

  function showSettingsPanel() {
    settingsPanel.classList.remove('hidden');
  }

  function hideSettingsPanel() {
    settingsPanel.classList.add('hidden');
  }

  // Show/Hide password field contents safely
  function toggleTokenVisibility() {
    if (bitbucketTokenInput.type === 'password') {
      bitbucketTokenInput.type = 'text';
      toggleTokenVisibilityBtn.textContent = '🙈';
    } else {
      bitbucketTokenInput.type = 'password';
      toggleTokenVisibilityBtn.textContent = '👁️';
    }
  }

  // Save extension settings and trigger background synchronization
  async function saveSettings() {
    const authType = authTypeSelect.value;
    const bitbucketUsername = bitbucketUsernameInput.value.trim();
    const bitbucketToken = bitbucketTokenInput.value.trim();

    if (!bitbucketToken) {
      alert('Please enter a Personal Access Token or App Password.');
      return;
    }

    if (authType === 'app_password' && !bitbucketUsername) {
      alert('Please enter your Bitbucket Username to use an App Password.');
      return;
    }

    // Save configuration parameters
    await chrome.storage.local.set({
      authType,
      bitbucketUsername,
      bitbucketToken
    });

    hideSettingsPanel();
    await triggerManualSync();
  }

  // Refresh Sync Handler
  async function triggerManualSync() {
    // Show Loading indication
    showLoading(true);
    hideError();
    emptyState.classList.add('hidden');
    setupHint.classList.add('hidden');

    try {
      // Send background refresh trigger message
      chrome.runtime.sendMessage({ type: 'REFRESH_PRS' }, async (response) => {
        // Wait briefly for storage write confirmation inside background.js
        setTimeout(async () => {
          const freshData = await chrome.storage.local.get([
            'prList',
            'lastUpdated',
            'error'
          ]);
          updateUI(freshData);
          showLoading(false);
        }, 800);
      });
    } catch (err) {
      console.error('Error contacting service worker:', err);
      showError('Message Failed', 'Could not communicate with background script.');
      showLoading(false);
    }
  }

  // Main UI Render Function for Bitbucket PR list
  function updateUI(data) {
    const hasToken = !!data.bitbucketToken;
    const prs = data.prList || [];
    const lastUpdate = data.lastUpdated;
    const currentError = data.error;

    // Render Time stamp
    if (lastUpdate) {
      const date = new Date(lastUpdate);
      lastUpdatedText.textContent = `Updated: ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } else {
      lastUpdatedText.textContent = 'Never updated';
    }

    // Clear old PRs
    prItemsContainer.innerHTML = '';

    // Handle Unconfigured state
    if (!hasToken) {
      prCountTitle.textContent = 'Pull Requests';
      setupHint.classList.remove('hidden');
      emptyState.classList.add('hidden');
      errorAlert.classList.add('hidden');
      return;
    }

    // Handle Error State
    if (currentError) {
      showError('Authentication / Sync Failed', currentError);
      setupHint.classList.add('hidden');
      emptyState.classList.add('hidden');
      prCountTitle.textContent = 'Pull Requests (Error)';
      return;
    }

    // Reset error alerts
    hideError();
    setupHint.classList.add('hidden');

    // Handle Empty PR state
    if (prs.length === 0) {
      prCountTitle.textContent = 'Pull Requests (0)';
      emptyState.classList.remove('hidden');
      return;
    }

    // Handle Active PR state
    emptyState.classList.add('hidden');
    prCountTitle.textContent = `Pull Requests (${prs.length})`;

    // Populate PR card items
    prs.forEach((pr) => {
      const card = document.createElement('a');
      card.className = 'pr-card';
      card.href = pr.url;
      card.target = '_blank';

      // Safe representation of creation date
      const createdDate = new Date(pr.createdOn);
      const dateOptions = { month: 'short', day: 'numeric' };
      const formattedDate = createdDate.toLocaleDateString(undefined, dateOptions);

      card.innerHTML = `
        <div class="pr-repo">${escapeHtml(pr.repoName)}</div>
        <div class="pr-title">${escapeHtml(pr.title)}</div>
        <div class="pr-meta">
          <span class="pr-author">${escapeHtml(pr.author)}</span>
          <span class="pr-date">${formattedDate}</span>
        </div>
      `;

      // Handled link behavior utilizing Chrome Tabs API for safety and Manifest compliance
      card.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: pr.url });
      });

      prItemsContainer.appendChild(card);
    });
  }

  // Loader and Alert triggers
  function showLoading(isLoading) {
    if (isLoading) {
      loadingIndicator.classList.remove('hidden');
      manualRefreshBtn.classList.add('hidden'); // hide manual trigger during active fetch
    } else {
      loadingIndicator.classList.add('hidden');
      manualRefreshBtn.classList.remove('hidden');
    }
  }

  function showError(title, msg) {
    errorTitle.textContent = title;
    errorMessage.textContent = msg;
    errorAlert.classList.remove('hidden');
  }

  function hideError() {
    errorAlert.classList.add('hidden');
  }

  // Escape HTML utility to prevent XSS issues when rendering PR content
  function escapeHtml(text) {
    if (!text) return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.toString().replace(/[&<>"']/g, (m) => map[m]);
  }
});
