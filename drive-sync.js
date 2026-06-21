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
    await loadScript('https://accounts.google.com/gsi/client');
    // Espera ativamente o objeto global ficar disponível — o script pode
    // ter terminado de carregar (onload) antes do `google.accounts` estar
    // de fato pronto para uso em alguns navegadores/condições de rede.
    let tries = 0;
    while ((!window.google || !window.google.accounts) && tries < 50) {
      await new Promise((r) => setTimeout(r, 100));
      tries++;
    }
    if (!window.google || !window.google.accounts) {
      throw new Error('google-identity-services-not-available');
    }
    gisLoaded = true;
  }

  async function init() {
    const clientId = getClientId();
    if (!clientId) {
      onStatusChange({ connected: false, reason: 'no-client-id' });
      return false;
    }
    await ensureGisLoaded();
    // Sempre recria o tokenClient com o client_id ATUAL salvo, mesmo se já
    // existir um de uma inicialização anterior — evita usar um client_id
    // desatualizado/vazio capturado por closure numa sessão anterior.
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: '', // set dynamically on each requestToken call
    });
    return true;
  }

  function requestToken(interactive = true) {
    return new Promise(async (resolve, reject) => {
      // Sempre garante um tokenClient fresco e válido para ESTA chamada,
      // em vez de confiar em um estado de inicialização anterior que pode
      // ter ficado inconsistente (ex: client_id mudou, ou init() parcial).
      const ok = await init().catch(() => false);
      if (!ok || !tokenClient) return reject(new Error('no-client-id'));

      tokenClient.callback = (resp) => {
        if (resp.error) return reject(resp);
        accessToken = resp.access_token;
        onStatusChange({ connected: true });
        resolve(accessToken);
      };
      tokenClient.error_callback = (err) => reject(err);
      try {
        tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function apiFetch(url, options = {}) {
    if (!accessToken) {
      throw new Error('not-authenticated'); // força reconexão explícita pelo usuário
    }
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (res.status === 401) {
      accessToken = null;
      throw new Error('token-expired'); // força reconexão explícita pelo usuário
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
