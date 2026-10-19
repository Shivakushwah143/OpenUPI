(() => {
  'use strict';

  const VIEWS = ['overview', 'links', 'transactions', 'observers'];
  const TITLES = {
    overview: 'Overview',
    links: 'Payment Links',
    transactions: 'Transactions',
    observers: 'Observers'
  };
  const PHASES = {
    AWAITING_PAYMENT: 'Awaiting payment',
    QUEUED: 'Queued',
    PAYMENT_DETECTED: 'Payment detected',
    SUCCESS: 'Success',
    FAILED: 'Failed',
    EXPIRED: 'Expired',
    CANCELLED: 'Cancelled',
    BLOCKED: 'Blocked'
  };
  const TERMINAL = new Set(['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED']);

  const state = {
    csrf: null,
    view: 'overview',
    link: null,
    linkTimer: null,
    countdownTimer: null,
    overviewLoaded: false,
    txLoaded: false,
    obsLoaded: false,
    pendingLink: false,
    toastTimer: null
  };

  const $ = selector => document.querySelector(selector);

  class ApiError extends Error {
    constructor(code, status, message) {
      super(message || code);
      this.code = code;
      this.status = status;
    }
  }

  const formatAmount = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)}`;
  };

  const formatPaise = paise => formatAmount(Number(paise || 0) / 100);

  const relativeTime = iso => {
    if (!iso) return '';
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return new Date(time).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  const heartbeatAge = seconds => {
    if (seconds === null || seconds === undefined) return 'no heartbeat yet';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
  };

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-OpenUPI-CSRF'] = state.csrf;

    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch {
      throw new ApiError('NETWORK', 0, 'Cannot reach the server. Check your connection.');
    }

    let body = null;
    try { body = await res.json(); } catch { body = null; }

    if (res.status === 401) {
      window.location.replace('/login');
      throw new ApiError('UNAUTHORIZED', 401, 'Your session expired. Sign in again.');
    }
    if (!res.ok) {
      const message = body?.message
        || (res.status === 429 ? 'Too many requests. Wait a moment.'
          : res.status === 502 || res.status === 504 ? 'The payment gateway is unreachable right now.'
            : 'Something went wrong. Try again.');
      throw new ApiError(body?.error || 'REQUEST_FAILED', res.status, message);
    }
    return body;
  }

  function pill(phase) {
    const el = document.createElement('span');
    el.className = 'status-pill';
    el.dataset.phase = phase || 'AWAITING_PAYMENT';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'status-text';
    text.textContent = PHASES[phase] || phase || 'Unknown';
    el.append(dot, text);
    return el;
  }

  function statePill(device) {
    const el = document.createElement('span');
    el.className = 'status-pill';
    el.dataset.state = device.status === 'CONNECTED' ? 'up' : 'down';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'status-text';
    text.textContent = device.status === 'CONNECTED' ? 'Connected' : 'Disconnected';
    el.append(dot, text);
    return el;
  }

  function skeletons(container, count = 3) {
    container.replaceChildren();
    for (let i = 0; i < count; i++) {
      const row = document.createElement('li');
      row.className = 'skeleton skeleton-row';
      row.setAttribute('aria-hidden', 'true');
      container.append(row);
    }
  }

  function showError(view, message) {
    const box = $(`#${view}Error`);
    if (!box) return;
    box.querySelector('.banner-text').textContent = message || '';
    box.hidden = !message;
  }

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function setSystemStatus(services) {
    const pillEl = $('#systemStatus');
    const textEl = $('#systemStatusText');
    if (!Array.isArray(services) || services.length === 0) {
      pillEl.dataset.state = 'loading';
      textEl.textContent = 'Status unavailable';
      return;
    }
    const apiService = services.find(service => service.name === 'Payment API');
    const anyDown = services.some(service => service.status === 'DOWN');
    const anyDegraded = services.some(service => service.status !== 'UP');
    if (apiService?.status === 'DOWN') {
      pillEl.dataset.state = 'down';
      textEl.textContent = 'Payment API offline';
    } else if (anyDown || anyDegraded) {
      pillEl.dataset.state = 'degraded';
      textEl.textContent = 'Partial outage';
    } else {
      pillEl.dataset.state = 'up';
      textEl.textContent = 'All systems operational';
    }
  }

  function renderActivity(rows) {
    const list = $('#ovRecent');
    const empty = $('#ovRecentEmpty');
    list.replaceChildren();
    if (!rows.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const row of rows.slice(0, 5)) {
      const li = document.createElement('li');
      li.className = 'activity-row';

      const main = document.createElement('div');
      main.className = 'activity-main';
      const title = document.createElement('div');
      title.className = 'activity-title';
      title.textContent = row.orderId;
      const sub = document.createElement('div');
      sub.className = 'activity-sub';
      sub.textContent = `${PHASES[row.phase] || row.phase} · ${relativeTime(row.createdAt)}`;
      main.append(title, sub);

      const amount = document.createElement('div');
      amount.className = 'activity-amount';
      amount.textContent = formatAmount(row.amount);

      const side = document.createElement('div');
      side.className = 'activity-side';
      side.append(pill(row.phase));

      li.append(main, amount, side);
      list.append(li);
    }
  }

  function renderOverview(data) {
    state.overviewLoaded = true;

    if (data.merchant) {
      $('#merchantName').textContent = data.merchant.businessName || 'Merchant';
      $('#merchantInitial').textContent = (data.merchant.businessName || 'O').trim().charAt(0).toUpperCase();
      $('#overviewSubtitle').textContent = `Live status for ${data.merchant.businessName || 'your merchant'}.`;
    }
    if (data.receiving?.upiId) {
      $('#payeeVpa').textContent = `Receiving ${data.receiving.upiId}`;
    } else {
      $('#payeeVpa').textContent = 'No active receiving VPA';
    }

    const stats = data.stats || {};
    $('#ovCollected').textContent = formatPaise(stats.collectedPaise || 0);
    $('#ovCollectedMeta').textContent = `${stats.recentCount || 0} recent payments · bank-confirmed only`;
    $('#ovAwaiting').textContent = String(stats.awaitingCount ?? 0);
    $('#ovDetected').textContent = String(stats.detectedCount ?? 0);

    const android = data.observers?.android;
    if (android) {
      $('#ovObserver').textContent = `${android.connectedDevices}/${android.totalDevices}`;
      const latest = android.devices?.[0];
      $('#ovObserverMeta').textContent = latest
        ? `Last heartbeat ${heartbeatAge(latest.heartbeatAgeSeconds)}`
        : 'No device paired yet';
    } else {
      $('#ovObserver').textContent = '—';
      $('#ovObserverMeta').textContent = 'Observer status unavailable';
    }

    renderActivity(data.transactions || []);
    setSystemStatus(data.services);

    const observers = $('#ovObservers');
    observers.replaceChildren();
    const addMini = (label, value, tone) => {
      const li = document.createElement('li');
      li.className = 'mini-row';
      const left = document.createElement('span');
      left.className = 'mini-label';
      const dot = document.createElement('span');
      dot.className = `mini-dot${tone ? ` is-${tone}` : ''}`;
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = label;
      left.append(dot, text);
      const right = document.createElement('span');
      right.className = 'mini-value';
      right.textContent = value;
      li.append(left, right);
      observers.append(li);
    };
    const toneFor = status => (status === 'CONNECTED' || status === 'UP' ? 'up' : status === 'DISCONNECTED' || status === 'DOWN' ? 'down' : 'warn');
    if (android?.devices?.length) {
      for (const device of android.devices.slice(0, 3)) {
        addMini(device.name || 'Android observer', `${device.status === 'CONNECTED' ? 'Connected' : 'Offline'} · ${heartbeatAge(device.heartbeatAgeSeconds)}`, toneFor(device.status));
      }
    } else {
      addMini('Android SMS observer', 'Not paired', 'warn');
    }
    addMini('Gmail observer', data.observers?.gmail?.status || 'STANDBY', toneFor(data.observers?.gmail?.status));
    addMini('SMS relay', data.observers?.sms?.status || 'STANDBY', toneFor(data.observers?.sms?.status));

    const services = $('#ovServices');
    services.replaceChildren();
    for (const service of data.services || []) {
      const li = document.createElement('li');
      li.className = 'mini-row';
      const left = document.createElement('span');
      left.className = 'mini-label';
      const dot = document.createElement('span');
      dot.className = `mini-dot is-${service.status === 'UP' ? 'up' : service.status === 'DOWN' ? 'down' : 'warn'}`;
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = service.name;
      left.append(dot, text);
      const right = document.createElement('span');
      right.className = 'mini-value';
      right.textContent = service.latencyMs !== null && service.latencyMs !== undefined
        ? `${service.status} · ${service.latencyMs}ms`
        : service.status;
      li.append(left, right);
      services.append(li);
    }

    if (data.degraded) {
      showError('ov', 'Some dashboard data could not be loaded. Retry in a moment.');
    } else {
      showError('ov', '');
    }
  }

  async function loadOverview({ silent = false } = {}) {
    const kpis = $('#ovKpis');
    if (!silent && !state.overviewLoaded) {
      kpis.setAttribute('aria-busy', 'true');
      skeletons($('#ovRecent'), 3);
    }
    try {
      const data = await api('/api/overview');
      renderOverview(data);
      showError('ov', '');
    } catch (err) {
      if (!state.overviewLoaded) {
        $('#ovCollected').textContent = '—';
        $('#ovAwaiting').textContent = '—';
        $('#ovDetected').textContent = '—';
        $('#ovObserver').textContent = '—';
      }
      showError('ov', err.message);
      setSystemStatus(null);
    } finally {
      kpis.setAttribute('aria-busy', 'false');
    }
  }

  function renderTransactions(rows) {
    const list = $('#txList');
    const empty = $('#txEmpty');
    list.replaceChildren();
    $('#txCount').textContent = String(rows.length);
    if (!rows.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'tx-row';

      const main = document.createElement('div');
      main.className = 'tx-main';
      const order = document.createElement('span');
      order.className = 'tx-order';
      order.textContent = row.orderId;
      const meta = document.createElement('span');
      meta.className = 'tx-meta';
      meta.textContent = `${row.method || 'UPI'} · ${relativeTime(row.createdAt)} · ${row.verificationTag || 'UNVERIFIED'}`;
      main.append(order, meta);

      const side = document.createElement('div');
      side.className = 'tx-side';
      const amount = document.createElement('span');
      amount.className = 'tx-amount';
      amount.textContent = formatAmount(row.amount);
      side.append(amount, pill(row.phase));

      li.append(main, side);
      list.append(li);
    }
  }

  async function loadTransactions({ silent = false } = {}) {
    if (!silent && !state.txLoaded) skeletons($('#txList'), 4);
    try {
      const data = await api('/api/transactions?limit=50');
      state.txLoaded = true;
      renderTransactions(data.transactions || []);
      showError('tx', '');
    } catch (err) {
      showError('tx', err.message);
    }
  }

  function renderObservers(data) {
    const list = $('#obsList');
    const empty = $('#obsEmpty');
    const android = data.android || { devices: [], totalDevices: 0, connectedDevices: 0 };
    list.replaceChildren();
    $('#obsSummary').textContent = `${android.connectedDevices || 0} of ${android.totalDevices || 0} online`;

    if (!android.devices?.length) {
      empty.hidden = false;
    } else {
      empty.hidden = true;
      for (const device of android.devices) {
        const li = document.createElement('li');
        li.className = 'observer-card';

        const main = document.createElement('div');
        main.className = 'observer-main';
        const name = document.createElement('div');
        name.className = 'observer-name';
        name.textContent = device.name || 'Android observer';
        const meta = document.createElement('div');
        meta.className = 'observer-meta';
        const parts = [];
        if (device.model) parts.push(device.model);
        parts.push(`heartbeat ${heartbeatAge(device.heartbeatAgeSeconds)}`);
        if (device.lastObservationAt) parts.push(`last observation ${relativeTime(device.lastObservationAt)}`);
        meta.textContent = parts.join(' · ');
        main.append(name, meta);

        const side = document.createElement('div');
        side.className = 'observer-side';
        side.append(statePill(device));

        li.append(main, side);
        list.append(li);
      }
    }

    const other = $('#obsOther');
    other.replaceChildren();
    const rows = [
      { label: 'Gmail observer', value: data.gmail?.status || 'STANDBY', tone: data.gmail?.isLoggedIn ? 'up' : 'warn' },
      { label: 'SMS relay', value: data.sms?.status || 'STANDBY', tone: data.sms?.isPaired ? 'up' : 'warn' }
    ];
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'mini-row';
      const left = document.createElement('span');
      left.className = 'mini-label';
      const dot = document.createElement('span');
      dot.className = `mini-dot is-${row.tone}`;
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = row.label;
      left.append(dot, text);
      const right = document.createElement('span');
      right.className = 'mini-value';
      right.textContent = row.value;
      li.append(left, right);
      other.append(li);
    }
  }

  async function loadObservers({ silent = false } = {}) {
    if (!silent && !state.obsLoaded) skeletons($('#obsList'), 2);
    try {
      const data = await api('/api/observers');
      state.obsLoaded = true;
      renderObservers(data);
      showError('obs', '');
    } catch (err) {
      showError('obs', err.message);
    }
  }

  // ---------------------------------------------------------------- payment links
  function setLinkError(message) {
    const el = $('#linkError');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function setResultError(message) {
    const el = $('#resultError');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function setLinkPending(value) {
    state.pendingLink = value;
    const button = $('#generateBtn');
    button.disabled = value;
    button.querySelector('.spinner').hidden = !value;
    button.querySelector('.btn-label').textContent = value ? 'Creating link…' : 'Generate payment link';
  }

  function renderLinkStatus(phase) {
    const status = $('#resultStatus');
    status.dataset.phase = phase;
    status.querySelector('.status-text').textContent = PHASES[phase] || phase;
    const hint = $('#resultPhaseHint');
    hint.dataset.phase = phase;
    if (phase === 'SUCCESS') {
      hint.textContent = 'Confirmed by the bank. This payment is settled.';
    } else if (phase === 'PAYMENT_DETECTED') {
      hint.textContent = 'Credit observed by the observer. Waiting for independent bank confirmation before marking success.';
    } else if (phase === 'EXPIRED') {
      hint.textContent = 'The payment window closed. Create a new link if the customer still wants to pay.';
    } else if (phase === 'FAILED' || phase === 'CANCELLED' || phase === 'BLOCKED') {
      hint.textContent = 'This payment did not complete. Create a new link to try again.';
    } else {
      hint.textContent = 'Waiting for the bank notification. Success is only shown after independent bank confirmation.';
    }
    return TERMINAL.has(phase);
  }

  function updateCountdown() {
    const el = $('#resultExpiry');
    if (!state.link?.checkoutUrl) { el.textContent = ''; return; }
    if (!state.link.expiresAt) { el.textContent = 'Share this link with the payer.'; return; }
    const remaining = Math.round((new Date(state.link.expiresAt).getTime() - Date.now()) / 1000);
    if (!Number.isFinite(remaining)) { el.textContent = ''; return; }
    if (remaining <= 0) {
      el.textContent = 'Payment window closed — bank confirmation may still arrive.';
      return;
    }
    const minutes = Math.floor(remaining / 60);
    const seconds = String(remaining % 60).padStart(2, '0');
    el.textContent = `Payment window closes in ${minutes}:${seconds}`;
  }

  function stopLinkTimers() {
    clearInterval(state.linkTimer);
    clearInterval(state.countdownTimer);
    state.linkTimer = null;
    state.countdownTimer = null;
  }

  function startLinkTimers() {
    stopLinkTimers();
    updateCountdown();
    state.countdownTimer = setInterval(updateCountdown, 1000);
    state.linkTimer = setInterval(pollLink, 3000);
  }

  async function pollLink() {
    if (!state.link?.paymentId || document.visibilityState !== 'visible') return;
    try {
      const data = await api(`/api/payment-links/${encodeURIComponent(state.link.paymentId)}`);
      state.link.phase = data.phase;
      if (renderLinkStatus(data.phase)) {
        stopLinkTimers();
        if (data.phase === 'SUCCESS') toast('Payment confirmed by the bank');
      }
      setResultError('');
    } catch (err) {
      if (err.status === 404) {
        stopLinkTimers();
        setResultError('This payment could not be found on the gateway.');
      }
    }
  }

  function renderResult(data) {
    $('#resultAmount').textContent = formatAmount(data.amount);
    $('#resultOrderId').textContent = `Order ${data.orderId}`;
    const link = $('#resultLink');
    link.value = data.checkoutUrl || '';
    const qr = $('#resultQr');
    if (data.qrUrl) {
      qr.src = data.qrUrl;
      qr.alt = `UPI QR code for ${formatAmount(data.amount)}`;
      qr.hidden = false;
    } else {
      qr.removeAttribute('src');
      qr.hidden = true;
    }
    $('#resultVpa').textContent = data.payeeVpa ? `Paying ${data.payeeVpa}` : 'Scan with any UPI app';
    $('#linkResult').hidden = false;
    renderLinkStatus(data.phase || 'AWAITING_PAYMENT');
    setResultError('');
    $('#newLinkBtn').hidden = false;
    link.focus();
    startLinkTimers();
  }

  async function createLink(event) {
    event.preventDefault();
    if (state.pendingLink) return;

    const amountInput = $('#amount');
    const amount = amountInput.value.trim();
    const note = $('#note').value.trim();

    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      setLinkError('Enter an amount like 10 or 10.50 (up to 2 decimals).');
      amountInput.focus();
      return;
    }
    const numeric = Number(amount);
    if (!(numeric >= 1 && numeric <= 100)) {
      setLinkError('Amount must be between ₹1.00 and ₹100.00.');
      amountInput.focus();
      return;
    }

    setLinkError('');
    setResultError('');
    setLinkPending(true);
    try {
      const data = await api('/api/payment-links', { method: 'POST', body: { amount, note } });
      state.link = data;
      renderResult(data);
      loadOverview({ silent: true });
    } catch (err) {
      setLinkError(err.message);
    } finally {
      setLinkPending(false);
    }
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy selection path (non-secure contexts).
    }
    try {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.className = 'visually-hidden';
      document.body.append(helper);
      helper.select();
      const ok = document.execCommand('copy');
      helper.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function shareLink() {
    const url = state.link?.checkoutUrl;
    if (!url) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'OpenUPI payment link',
          text: `Pay ${formatAmount(state.link.amount)} with UPI`,
          url
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    const copied = await copyText(url);
    toast(copied ? 'Link copied — paste it to share' : 'Could not share this link');
  }

  async function logout() {
    try {
      await api('/api/session', { method: 'DELETE' });
    } catch {
      // Always return to the sign-in page: the cookie is cleared server-side.
    }
    window.location.replace('/login');
  }

  // ------------------------------------------------------------------- routing
  function switchView(name, { updateUrl = true } = {}) {
    const view = VIEWS.includes(name) ? name : 'overview';
    state.view = view;
    document.querySelectorAll('.nav-item').forEach(button => {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('[data-view-panel]').forEach(panel => {
      panel.hidden = panel.dataset.viewPanel !== view;
    });
    document.title = `${TITLES[view]} · OpenUPI Admin`;
    if (updateUrl) {
      history.replaceState(null, '', `#${view}`);
    }
    if (view === 'overview') loadOverview();
    if (view === 'transactions') loadTransactions();
    if (view === 'observers') loadObservers();
    if (view === 'links' && state.link) updateCountdown();
  }

  function wireEvents() {
    document.querySelectorAll('.nav-item').forEach(button => {
      button.addEventListener('click', () => switchView(button.dataset.view));
    });
    document.querySelectorAll('[data-goto]').forEach(button => {
      button.addEventListener('click', () => switchView(button.dataset.goto));
    });
    document.querySelectorAll('[data-retry]').forEach(button => {
      button.addEventListener('click', () => {
        const target = button.dataset.retry;
        if (target === 'overview') loadOverview();
        if (target === 'transactions') loadTransactions();
        if (target === 'observers') loadObservers();
      });
    });

    $('#ovRefresh').addEventListener('click', () => loadOverview());
    $('#txRefresh').addEventListener('click', () => loadTransactions());
    $('#obsRefresh').addEventListener('click', () => loadObservers());

    $('#linkForm').addEventListener('submit', createLink);
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const input = $('#amount');
        input.value = chip.dataset.amount;
        document.querySelectorAll('.chip').forEach(other => other.setAttribute('aria-pressed', String(other === chip)));
        setLinkError('');
        input.focus();
      });
    });
    $('#amount').addEventListener('input', () => {
      document.querySelectorAll('.chip').forEach(chip => {
        chip.setAttribute('aria-pressed', String(chip.dataset.amount === $('#amount').value.trim()));
      });
    });

    $('#copyBtn').addEventListener('click', async () => {
      const ok = await copyText(state.link?.checkoutUrl);
      toast(ok ? 'Checkout link copied' : 'Copy failed — select the link manually');
    });
    $('#shareBtn').addEventListener('click', shareLink);
    $('#openBtn').addEventListener('click', () => {
      if (!state.link?.checkoutUrl) return;
      window.open(state.link.checkoutUrl, '_blank', 'noopener,noreferrer');
    });
    $('#newLinkBtn').addEventListener('click', () => {
      stopLinkTimers();
      state.link = null;
      $('#linkResult').hidden = true;
      $('#linkForm').reset();
      document.querySelectorAll('.chip').forEach(chip => chip.setAttribute('aria-pressed', 'false'));
      setLinkError('');
      $('#amount').focus();
    });

    $('#logoutBtn').addEventListener('click', logout);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (state.view === 'overview') loadOverview({ silent: true });
        if (state.view === 'transactions') loadTransactions({ silent: true });
      }
    });

    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (state.view === 'overview') loadOverview({ silent: true });
      if (state.view === 'transactions') loadTransactions({ silent: true });
      if (state.view === 'observers') loadObservers({ silent: true });
    }, 30_000);
  }

  async function boot() {
    wireEvents();
    try {
      const session = await api('/api/session');
      if (!session?.authenticated) {
        window.location.replace('/login');
        return;
      }
      state.csrf = session.csrfToken;
    } catch {
      window.location.replace('/login');
      return;
    }
    const requested = window.location.hash.replace('#', '');
    switchView(VIEWS.includes(requested) ? requested : 'overview', { updateUrl: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
