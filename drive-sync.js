/* ══════════════════════════════════════════════
   GOOGLE DRIVE SYNC
   Salva o state inteiro como um único arquivo JSON
   na pasta privada "appDataFolder" da conta do usuário.
   Essa pasta é invisível no Drive normal — só este app
   consegue ler/escrever nela.
══════════════════════════════════════════════ */

const DriveSync = (() => {
  const STORAGE_KEY_CLIENT_ID = 'mgrana_google_client_id';
  const DRIVE_FILE_NAME = 'minhagrana_state.json';
  const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';

  let tokenClient = null;
  let accessToken = null;
  let driveFileId = null; // cache do id do arquivo na appDataFolder
  let gisLoaded = false;
  let onStatusChange = () => {};

  function getClientId() {
    return localStorage.getItem(STORAGE_KEY_CLIENT_ID) || '';
  }

  function setClientId(id) {
    localStorage.setItem(STORAGE_KEY_CLIENT_ID, id.trim());
  }

  function setStatusCallback(fn) {
    onStatusChange = fn;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function ensureGisLoaded() {
    if (gisLoaded) return;
    await loadScript('https://accounts.google.com/gsi/client');
    gisLoaded = true;
  }

  async function init() {
    const clientId = getClientId();
    if (!clientId) {
      onStatusChange({ connected: false, reason: 'no-client-id' });
      return false;
    }
    await ensureGisLoaded();
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: '', // set dynamically on each requestToken call
    });
    return true;
  }

  function requestToken(interactive = true) {
    return new Promise(async (resolve, reject) => {
      if (!tokenClient) {
        const ok = await init();
        if (!ok) return reject(new Error('no-client-id'));
      }
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(resp);
        accessToken = resp.access_token;
        onStatusChange({ connected: true });
        resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    });
  }

  async function apiFetch(url, options = {}) {
    if (!accessToken) await requestToken(false).catch(() => requestToken(true));
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (res.status === 401) {
      accessToken = null;
      await requestToken(true);
      return apiFetch(url, options);
    }
    return res;
  }

  async function findDriveFile() {
    if (driveFileId) return driveFileId;
    const res = await apiFetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)&q=name='${DRIVE_FILE_NAME}'`
    );
    const data = await res.json();
    if (data.files && data.files.length) {
      driveFileId = data.files[0].id;
      return driveFileId;
    }
    return null;
  }

  async function pullFromDrive() {
    const fileId = await findDriveFile();
    if (!fileId) return null;
    const res = await apiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  async function pushToDrive(stateObj) {
    const fileId = await findDriveFile();
    const body = JSON.stringify(stateObj);
    const metadata = { name: DRIVE_FILE_NAME, mimeType: 'application/json' };

    if (fileId) {
      const res = await apiFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }
      );
      return res.ok;
    } else {
      metadata.parents = ['appDataFolder'];
      const boundary = '-------mgrana' + Date.now();
      const multipartBody =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
        body +
        `\r\n--${boundary}--`;

      const res = await apiFetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body: multipartBody,
        }
      );
      const data = await res.json();
      if (data.id) driveFileId = data.id;
      return res.ok;
    }
  }

  function isConnected() {
    return !!getClientId();
  }

  function disconnect() {
    accessToken = null;
    driveFileId = null;
    tokenClient = null;
    localStorage.removeItem(STORAGE_KEY_CLIENT_ID);
    onStatusChange({ connected: false, reason: 'disconnected' });
  }

  return {
    getClientId,
    setClientId,
    setStatusCallback,
    init,
    requestToken,
    pullFromDrive,
    pushToDrive,
    isConnected,
    disconnect,
  };
})();
