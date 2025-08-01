// background/service-worker.js

// Estado global del service worker
let sessionData = {
  seed: null,
  profile: null,
  initialized: false
};

// Inicialización cuando se instala la extensión
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Chameleon] Extension installed/updated');
  await initializeSession();
});

// Inicialización cuando se inicia el navegador
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Chameleon] Browser started');
  await initializeSession();
});

// Inicializa una nueva sesión
async function initializeSession() {
  // Generar nueva semilla
  const seed = generateSessionSeed();
  
  // Guardar en storage
  await chrome.storage.session.set({ 
    sessionSeed: seed,
    sessionStartTime: Date.now()
  });
  
  sessionData.seed = seed;
  sessionData.initialized = true;
  
  console.log('[Chameleon] New session initialized with seed:', seed.substring(0, 8) + '...');
  
  // Limpiar cookies y cache de sitios objetivo
  await clearTargetSiteData();
}

// Genera una semilla criptográficamente segura
function generateSessionSeed() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Limpia datos de sitios específicos
async function clearTargetSiteData() {
  const targetDomains = [
    'twitch.tv',
    'youtube.com',
    'facebook.com',
    'meta.com',
    'tiktok.com'
  ];
  
  try {
    for (const domain of targetDomains) {
      // Limpiar cookies
      const cookies = await chrome.cookies.getAll({ domain: `.${domain}` });
      for (const cookie of cookies) {
        await chrome.cookies.remove({
          url: `https://${cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain}${cookie.path}`,
          name: cookie.name
        });
      }
    }
    
    // Limpiar otros datos
    await chrome.browsingData.remove({
      hostnames: targetDomains
    }, {
      cache: true,
      localStorage: true,
      indexedDB: true
    });
    
    console.log('[Chameleon] Cleared data for target sites');
  } catch (error) {
    console.error('[Chameleon] Error clearing site data:', error);
  }
}

// Manejo de mensajes
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Chameleon] Received message:', request.action);
  
  switch (request.action) {
    case 'getSessionSeed':
      handleGetSessionSeed().then(sendResponse);
      return true;
      
    case 'regenerateIdentity':
      handleRegenerateIdentity().then(sendResponse);
      return true;
      
    case 'getSessionInfo':
      getSessionInfo().then(sendResponse);
      return true;
      
    case 'checkVPN':
      checkVPNStatus().then(sendResponse);
      return true;
      
    default:
      console.warn('[Chameleon] Unknown message action:', request.action);
      sendResponse({ error: 'Unknown action' });
  }
  
  return false;
});

// Obtener semilla de sesión
async function handleGetSessionSeed() {
  try {
    if (!sessionData.initialized) {
      await initializeSession();
    }
    
    const stored = await chrome.storage.session.get('sessionSeed');
    return { seed: stored.sessionSeed || sessionData.seed };
  } catch (error) {
    console.error('[Chameleon] Error getting session seed:', error);
    return { seed: generateSessionSeed() };
  }
}

// Regenera la identidad manualmente
async function handleRegenerateIdentity() {
  try {
    await chrome.storage.session.clear();
    await initializeSession();
    
    // Recargar todas las pestañas
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url && !tab.url.startsWith('chrome://')) {
        chrome.tabs.reload(tab.id);
      }
    }
    
    return { success: true, message: 'Identity regenerated successfully' };
  } catch (error) {
    console.error('[Chameleon] Error regenerating identity:', error);
    return { success: false, error: error.message };
  }
}

// Obtiene información de la sesión actual
async function getSessionInfo() {
  try {
    const stored = await chrome.storage.session.get(['sessionSeed', 'profile']);
    return { 
      seed: stored.sessionSeed || sessionData.seed,
      profile: stored.profile 
    };
  } catch (error) {
    console.error('[Chameleon] Error getting session info:', error);
    return { error: error.message };
  }
}

// Verifica el estado de VPN
async function checkVPNStatus() {
  try {
    const response = await fetch('https://ipapi.co/json/', {
      cache: 'no-store'
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch IP info');
    }
    
    const data = await response.json();
    
    // Detectar indicadores de VPN
    const vpnIndicators = [
      data.org?.toLowerCase().includes('vpn'),
      data.org?.toLowerCase().includes('proxy'),
      data.org?.toLowerCase().includes('hosting'),
      data.org?.toLowerCase().includes('cloud'),
      data.org?.toLowerCase().includes('datacenter')
    ];
    
    const isVPN = vpnIndicators.some(indicator => indicator === true);
    
    return {
      ip: data.ip,
      country: data.country_name,
      city: data.city,
      timezone: data.timezone,
      org: data.org,
      isVPN,
      asn: data.asn
    };
  } catch (error) {
    console.error('[Chameleon] Error checking VPN status:', error);
    return { error: 'Failed to check VPN status' };
  }
}

// Inyectar script en una pestaña
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url && !tab.url.startsWith('chrome://')) {
    try {
      // Asegurar que la sesión esté inicializada
      if (!sessionData.initialized) {
        await initializeSession();
      }
    } catch (error) {
      console.error('[Chameleon] Error on tab update:', error);
    }
  }
});