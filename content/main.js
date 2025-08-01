// content/main.js
(() => {
  'use strict';
  
  // Verificar que estamos en el MAIN world
  if (typeof window.chameleonInitialized !== 'undefined') {
    console.warn('[Chameleon] Already initialized, skipping...');
    return;
  }
  
  window.chameleonInitialized = true;
  console.log('[Chameleon] Initializing in MAIN world...');
  
  // Importar módulos necesarios
  const modules = {
    seedManager: null,
    profileGenerator: null,
    metaProxy: null,
    navigatorInterceptor: null,
    screenInterceptor: null,
    canvasInterceptor: null,
    webglInterceptor: null,
    audioInterceptor: null,
    timezoneInterceptor: null,
    jitter: null,
    platformDetector: null,
    vpnDetector: null
  };
  
  // Estado global de la extensión
  const chameleonState = {
    seed: null,
    profile: null,
    initialized: false,
    interceptors: new Map(),
    detectedPlatform: null,
    vpnStatus: null
  };
  
  // Función principal de inicialización
  async function initialize() {
    try {
      // 1. Obtener la semilla de sesión
      chameleonState.seed = await getSeedFromExtension();
      
      // 2. Cargar perfiles desde el archivo JSON
      const profilesData = await loadProfiles();
      
      // 3. Generar perfil basado en la semilla
      chameleonState.profile = generateProfile(chameleonState.seed, profilesData);
      
      // 4. Detectar plataforma actual
      chameleonState.detectedPlatform = detectCurrentPlatform();
      
      // 5. Aplicar meta-proxy para protección contra detección
      applyMetaProxy();
      
      // 6. Aplicar interceptores (lazy loading)
      setupLazyInterceptors();
      
      // 7. Verificar coherencia IP/VPN
      checkIPCoherence();
      
      chameleonState.initialized = true;
      console.log('[Chameleon] Initialization complete', {
        profile: chameleonState.profile.summary,
        platform: chameleonState.detectedPlatform
      });
      
    } catch (error) {
      console.error('[Chameleon] Initialization failed:', error);
    }
  }
  
  // Obtener semilla desde el service worker
  async function getSeedFromExtension() {
    // Comunicación con el service worker mediante CustomEvent
    return new Promise((resolve) => {
      const channelId = 'chameleon_' + Math.random().toString(36).substr(2, 9);
      
      window.addEventListener(channelId, (event) => {
        resolve(event.detail.seed);
      }, { once: true });
      
      // Inyectar script para comunicarse con el contexto aislado
      const script = document.createElement('script');
      script.textContent = `
        (async () => {
          const response = await chrome.runtime.sendMessage({ action: 'getSessionInfo' });
          window.dispatchEvent(new CustomEvent('${channelId}', { 
            detail: { seed: response.seed } 
          }));
        })();
      `;
      document.documentElement.appendChild(script);
      script.remove();
    });
  }
  
  // Cargar perfiles desde el archivo JSON
  async function loadProfiles() {
    const response = await fetch(chrome.runtime.getURL('data/profiles.json'));
    return await response.json();
  }
  
  // Generar perfil coherente basado en la semilla
  function generateProfile(seed, profilesData) {
    // Usar seedrandom para determinismo
    const rng = new Math.seedrandom(seed);
    
    // Seleccionar arquetipo de dispositivo
    const archetype = selectWeighted(profilesData.deviceArchetypes, rng);
    
    // Seleccionar características específicas dentro del arquetipo
    const cpu = selectWeighted(
      archetype.hardware.cpu.cores.map((c, i) => ({ 
        value: c, 
        weight: archetype.hardware.cpu.weights[i] 
      })), 
      rng
    );
    
    const memory = selectFromArray(archetype.hardware.memory, rng);
    const gpu = selectFromArray(archetype.hardware.gpuVendors, rng);
    const gpuModel = selectFromArray(gpu.models, rng);
    const resolution = selectWeighted(archetype.display.resolutions, rng);
    const language = selectWeighted(
      archetype.languages.primary.map((l, i) => ({ 
        value: l, 
        weight: archetype.languages.weights[i] 
      })), 
      rng
    );
    
    // Seleccionar región y timezone coherente
    const region = selectWeighted(
      Object.entries(profilesData.timezoneRegions).map(([name, zones]) => ({
        value: { name, zones },
        weight: zones.reduce((sum, z) => sum + z.weight, 0)
      })),
      rng
    );
    
    const timezoneData = selectWeighted(region.value.zones, rng);
    
    // Seleccionar versión de Chrome
    const chromeVersion = selectWeighted(profilesData.chromeVersions, rng);
    
    // Construir User-Agent
    let userAgent = archetype.userAgentTemplate.replace('{chromeVersion}', chromeVersion.version);
    
    if (archetype.platform === 'Linux armv8l') {
      const deviceModel = selectFromArray(profilesData.androidDeviceModels, rng);
      userAgent = userAgent
        .replace('{androidVersion}', archetype.os.version)
        .replace('{deviceModel}', deviceModel);
    }
    
    // Generar lista de plugins coherente
    const plugins = generatePlugins(archetype, rng);
    
    // Generar perfil completo
    const profile = {
      seed,
      archetype: archetype.id,
      summary: `${archetype.name} - ${resolution.width}x${resolution.height} - ${timezoneData.timezone}`,
      
      navigator: {
        userAgent,
        platform: archetype.platform,
        language,
        languages: generateLanguagesList(language, rng),
        hardwareConcurrency: cpu.value,
        deviceMemory: memory,
        maxTouchPoints: archetype.display.touchPoints,
        vendor: 'Google Inc.',
        vendorSub: '',
        productSub: '20030107',
        cookieEnabled: true,
        onLine: true,
        webdriver: false,
        pdfViewerEnabled: true,
        plugins
      },
      
      screen: {
        width: resolution.width,
        height: resolution.height,
        availWidth: resolution.width,
        availHeight: resolution.height - getTaskbarHeight(archetype.os.name),
        colorDepth: archetype.display.colorDepth,
        pixelDepth: archetype.display.pixelDepth,
        orientation: {
          angle: 0,
          type: resolution.width > resolution.height ? 'landscape-primary' : 'portrait-primary'
        }
      },
      
      webgl: {
        vendor: gpu.vendor,
        renderer: gpu.renderer.replace('{model}', gpuModel),
        version: 'WebGL 2.0',
        shadingLanguageVersion: 'WebGL GLSL ES 3.00',
        extensions: generateWebGLExtensions(gpu.vendor, rng)
      },
      
      canvas: {
        noise: rng() * 0.0001 + 0.00005, // 0.00005 - 0.00015
        offsetX: Math.floor(rng() * 3) - 1, // -1, 0, 1
        offsetY: Math.floor(rng() * 3) - 1
      },
      
      audio: {
        sampleRate: 48000,
        channelCount: 2,
        noise: rng() * 0.00002 + 0.00001 // Ruido muy bajo
      },
      
      timezone: {
        name: timezoneData.timezone,
        offset: getTimezoneOffset(timezoneData.timezone),
        locale: language
      },
      
      fonts: selectFonts(archetype, rng),
      
      battery: {
        charging: rng() > 0.3,
        level: 0.5 + rng() * 0.5,
        chargingTime: rng() > 0.3 ? Math.floor(rng() * 3600) : Infinity,
        dischargingTime: Math.floor(rng() * 10800) + 3600
      }
    };
    
    return profile;
  }
  
  // Funciones auxiliares para generación de perfil
  function selectWeighted(items, rng) {
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    let random = rng() * totalWeight;
    
    for (const item of items) {
      random -= item.weight;
      if (random <= 0) return item;
    }
    
    return items[items.length - 1];
  }
  
  function selectFromArray(array, rng) {
    return array[Math.floor(rng() * array.length)];
  }
  
  function generateLanguagesList(primary, rng) {
    const languages = [primary];
    const baseLang = primary.split('-')[0];
    
    // Agregar variantes del idioma
    if (baseLang === 'en' && primary !== 'en-US') {
      languages.push('en-US');
    }
    
    languages.push(baseLang);
    
    // Agregar inglés si no está presente
    if (!languages.some(l => l.startsWith('en'))) {
      languages.push('en-US', 'en');
    }
    
    return languages;
  }
  
  function getTaskbarHeight(os) {
    switch (os) {
      case 'Windows': return 40;
      case 'macOS': return 25;
      case 'Linux': return 28;
      default: return 0;
    }
  }
  
  function generatePlugins(archetype, rng) {
    const plugins = [];
    
    if (archetype.platform !== 'Linux armv8l') { // No mobile
      plugins.push(
        {
          name: 'PDF Viewer',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          mimeTypes: [{
            type: 'application/pdf',
            suffixes: 'pdf',
            description: 'Portable Document Format'
          }]
        },
        {
          name: 'Chrome PDF Viewer',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          mimeTypes: [{
            type: 'application/pdf',
            suffixes: 'pdf',
            description: 'Portable Document Format'
          }]
        }
      );
      
      if (rng() > 0.5) {
        plugins.push({
          name: 'Native Client',
          description: 'Native Client Executable',
          filename: 'internal-nacl-plugin',
          mimeTypes: [{
            type: 'application/x-nacl',
            suffixes: '',
            description: 'Native Client Executable'
          }]
        });
      }
    }
    
    return plugins;
  }
  
  function generateWebGLExtensions(vendor, rng) {
    const baseExtensions = [
      'EXT_blend_minmax',
      'EXT_color_buffer_half_float',
      'EXT_disjoint_timer_query',
      'EXT_float_blend',
      'EXT_frag_depth',
      'EXT_shader_texture_lod',
      'EXT_texture_compression_bptc',
      'EXT_texture_compression_rgtc',
      'EXT_texture_filter_anisotropic',
      'EXT_sRGB',
      'KHR_parallel_shader_compile',
      'OES_element_index_uint',
      'OES_fbo_render_mipmap',
      'OES_standard_derivatives',
      'OES_texture_float',
      'OES_texture_float_linear',
      'OES_texture_half_float',
      'OES_texture_half_float_linear',
      'OES_vertex_array_object',
      'WEBGL_color_buffer_float',
      'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_s3tc_srgb',
      'WEBGL_debug_renderer_info',
      'WEBGL_debug_shaders',
      'WEBGL_depth_texture',
      'WEBGL_draw_buffers',
      'WEBGL_lose_context',
      'WEBGL_multi_draw'
    ];
    
    // Agregar extensiones específicas del vendor
    if (vendor === 'NVIDIA') {
      baseExtensions.push('NV_shader_noperspective_interpolation');
    } else if (vendor === 'AMD') {
      baseExtensions.push('AMD_compressed_ATC_texture');
    }
    
    // Mezclar aleatoriamente
    return baseExtensions.sort(() => rng() - 0.5);
  }
  
  function getTimezoneOffset(timezone) {
    try {
      const date = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short'
      });
      
      // Calcular offset
      const parts = formatter.formatToParts(date);
      const timezoneName = parts.find(p => p.type === 'timeZoneName').value;
      
      // Mapeo básico de zonas horarias comunes
      const offsetMap = {
        'PST': 480, 'PDT': 420,
        'MST': 420, 'MDT': 360,
        'CST': 360, 'CDT': 300,
        'EST': 300, 'EDT': 240,
        'GMT': 0, 'BST': -60,
        'CET': -60, 'CEST': -120,
        'JST': -540, 'KST': -540,
        'CST': -480, 'IST': -330
      };
      
      return offsetMap[timezoneName] || 0;
    } catch (e) {
      return 0;
    }
  }
  
  function selectFonts(archetype, rng) {
    const fontKey = archetype.os.name.toLowerCase();
    const allFonts = archetype.fonts[fontKey] || archetype.fonts.windows || [];
    
    // Seleccionar un subconjunto aleatorio pero coherente
    const fontCount = Math.floor(rng() * 20) + 30; // 30-50 fuentes
    const selectedFonts = [];
    const fontsCopy = [...allFonts];
    
    for (let i = 0; i < fontCount && fontsCopy.length > 0; i++) {
      const index = Math.floor(rng() * fontsCopy.length);
      selectedFonts.push(fontsCopy.splice(index, 1)[0]);
    }
    
    return selectedFonts.sort();
  }
  
  // Detectar plataforma actual
  function detectCurrentPlatform() {
    const hostname = window.location.hostname;
    
    if (hostname.includes('twitch.tv')) return 'twitch';
    if (hostname.includes('youtube.com')) return 'youtube';
    if (hostname.includes('facebook.com') || hostname.includes('meta.com')) return 'meta';
    if (hostname.includes('tiktok.com')) return 'tiktok';
    if (hostname.includes('fingerprint.com')) return 'fingerprint';
    
    return 'other';
  }
  
  // Aplicar meta-proxy para protección contra detección
  function applyMetaProxy() {
    console.log('[Chameleon] Applying meta-proxy protection...');
    
    // Guardar referencia original
    const originalToString = Function.prototype.toString;
    const nativeCode = 'function () { [native code] }';
    
    // Map de funciones interceptadas
    const interceptedFunctions = new WeakSet();
    
    // Registrar función como interceptada
    window.chameleonRegisterIntercepted = function(fn) {
      interceptedFunctions.add(fn);
    };
    
    // Crear meta-proxy
    Function.prototype.toString = new Proxy(originalToString, {
      apply(target, thisArg, args) {
        // Si la función está en nuestro conjunto de interceptadas
        if (interceptedFunctions.has(thisArg)) {
          // Obtener el nombre de la función si existe
          const fnName = thisArg.name || '';
          
          if (fnName) {
            return `function ${fnName}() { [native code] }`;
          }
          return nativeCode;
        }
        
        // Para otras funciones, comportamiento normal
        return Reflect.apply(target, thisArg, args);
      }
    });
    
    // Proteger el meta-proxy mismo
    interceptedFunctions.add(Function.prototype.toString);
    
    // Proteger Object.prototype.toString
    const originalObjectToString = Object.prototype.toString;
    Object.prototype.toString = new Proxy(originalObjectToString, {
      apply(target, thisArg, args) {
        // Detectar si están intentando inspeccionar nuestros objetos falsos
        if (thisArg && thisArg._chameleonFakeObject) {
          return thisArg._chameleonToStringTag || '[object Object]';
        }
        return Reflect.apply(target, thisArg, args);
      }
    });
    
    interceptedFunctions.add(Object.prototype.toString);
    
    // Proteger Error.stack para evitar detección por stack traces
    const OriginalError = Error;
    const originalCaptureStackTrace = Error.captureStackTrace;
    
    if (originalCaptureStackTrace) {
      Error.captureStackTrace = function(targetObject, constructorOpt) {
        originalCaptureStackTrace.call(this, targetObject, constructorOpt);
        
        // Limpiar stack trace de referencias a Chameleon
        if (targetObject.stack) {
          targetObject.stack = targetObject.stack
            .split('\n')
            .filter(line => !line.includes('chameleon'))
            .join('\n');
        }
      };
    }
    
    console.log('[Chameleon] Meta-proxy protection applied');
  }
  
  // Configurar interceptores con lazy loading
  function setupLazyInterceptors() {
    console.log('[Chameleon] Setting up lazy interceptors...');
    
    // Interceptores de alta prioridad (aplicar inmediatamente)
    applyNavigatorInterceptor();
    applyScreenInterceptor();
    
    // Interceptores de baja prioridad (lazy loading)
    setupCanvasLazyInterceptor();
    setupWebGLLazyInterceptor();
    setupAudioLazyInterceptor();
    setupTimezoneInterceptor();
    setupBatteryInterceptor();
    
    console.log('[Chameleon] Lazy interceptors configured');
  }
  
  // Interceptor de Navigator (alta prioridad)
  function applyNavigatorInterceptor() {
    const profile = chameleonState.profile.navigator;
    
    // User Agent
    defineProperty(navigator, 'userAgent', profile.userAgent);
    
    // Platform
    defineProperty(navigator, 'platform', profile.platform);
    
    // Languages
    defineProperty(navigator, 'language', profile.language);
    defineProperty(navigator, 'languages', profile.languages);
    
    // Hardware
    defineProperty(navigator, 'hardwareConcurrency', profile.hardwareConcurrency);
    defineProperty(navigator, 'deviceMemory', profile.deviceMemory);
    defineProperty(navigator, 'maxTouchPoints', profile.maxTouchPoints);
    
    // Vendor
    defineProperty(navigator, 'vendor', profile.vendor);
    defineProperty(navigator, 'vendorSub', profile.vendorSub);
    defineProperty(navigator, 'productSub', profile.productSub);
    
    // WebDriver
    defineProperty(navigator, 'webdriver', profile.webdriver);
    
    // Plugins
    const fakePluginArray = createFakePluginArray(profile.plugins);
    defineProperty(navigator, 'plugins', fakePluginArray);
    
    // MimeTypes
    const fakeMimeTypeArray = createFakeMimeTypeArray(profile.plugins);
    defineProperty(navigator, 'mimeTypes', fakeMimeTypeArray);
    
    // PDF Viewer
    defineProperty(navigator, 'pdfViewerEnabled', profile.pdfViewerEnabled);
    
    // Connection
    if (navigator.connection) {
      defineProperty(navigator.connection, 'effectiveType', '4g');
      defineProperty(navigator.connection, 'rtt', 50);
      defineProperty(navigator.connection, 'downlink', 10);
      defineProperty(navigator.connection, 'saveData', false);
    }
    
    console.log('[Chameleon] Navigator interceptor applied');
  }
  
  // Interceptor de Screen (alta prioridad)
  function applyScreenInterceptor() {
    const profile = chameleonState.profile.screen;
    
    defineProperty(screen, 'width', profile.width);
    defineProperty(screen, 'height', profile.height);
    defineProperty(screen, 'availWidth', profile.availWidth);
    defineProperty(screen, 'availHeight', profile.availHeight);
    defineProperty(screen, 'colorDepth', profile.colorDepth);
    defineProperty(screen, 'pixelDepth', profile.pixelDepth);
    
    // Screen orientation
    if (screen.orientation) {
      defineProperty(screen.orientation, 'angle', profile.orientation.angle);
      defineProperty(screen.orientation, 'type', profile.orientation.type);
    }
    
    // Window properties
    defineProperty(window, 'screenX', 0);
    defineProperty(window, 'screenY', 0);
    defineProperty(window, 'screenLeft', 0);
    defineProperty(window, 'screenTop', 0);
    defineProperty(window, 'outerWidth', profile.width);
    defineProperty(window, 'outerHeight', profile.height);
    
    // Device pixel ratio
    defineProperty(window, 'devicePixelRatio', 1);
    
    console.log('[Chameleon] Screen interceptor applied');
  }
  
  // Canvas Lazy Interceptor
  function setupCanvasLazyInterceptor() {
    let canvasInterceptorApplied = false;
    
    // Interceptar acceso a métodos de canvas
    const canvasMethods = ['toDataURL', 'toBlob', 'getImageData'];
    
    canvasMethods.forEach(method => {
      const original = HTMLCanvasElement.prototype[method];
      
      HTMLCanvasElement.prototype[method] = new Proxy(original, {
        apply(target, thisArg, args) {
          if (!canvasInterceptorApplied) {
            applyCanvasInterceptor();
            canvasInterceptorApplied = true;
          }
          
          // Aplicar jitter
          return applyJitter(() => {
            return chameleonState.interceptors.get('canvas')[method].apply(thisArg, args);
          });
        }
      });
      
      chameleonRegisterIntercepted(HTMLCanvasElement.prototype[method]);
    });
  }
  
  // Canvas Interceptor completo
  function applyCanvasInterceptor() {
    console.log('[Chameleon] Applying canvas interceptor...');
    
    const profile = chameleonState.profile.canvas;
    const rng = new Math.seedrandom(chameleonState.seed + 'canvas');
    
    // Función para aplicar ruido determinista
    function applyCanvasNoise(canvas) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      // Detectar bordes usando Sobel simplificado
      const edges = detectEdges(data, canvas.width, canvas.height);
      
      // Aplicar ruido solo en los bordes
      for (let i = 0; i < edges.length; i++) {
        if (edges[i] > 128) { // Es un borde
          const pixelIndex = i * 4;
          const noise = (rng() - 0.5) * profile.noise * 255;
          
          data[pixelIndex] = Math.min(255, Math.max(0, data[pixelIndex] + noise));
          data[pixelIndex + 1] = Math.min(255, Math.max(0, data[pixelIndex + 1] + noise));
          data[pixelIndex + 2] = Math.min(255, Math.max(0, data[pixelIndex + 2] + noise));
        }
      }
      
      ctx.putImageData(imageData, 0, 0);
      
      // Agregar un píxel casi invisible basado en la semilla
      ctx.save();
      ctx.globalAlpha = 0.01;
      ctx.fillStyle = `rgb(${Math.floor(rng() * 256)}, ${Math.floor(rng() * 256)}, ${Math.floor(rng() * 256)})`;
      ctx.fillRect(
        canvas.width - 1 + profile.offsetX,
        canvas.height - 1 + profile.offsetY,
        1, 1
      );
      ctx.restore();
    }
    
    // Detección de bordes simplificada
    function detectEdges(data, width, height) {
      const edges = new Uint8Array(width * height);
      
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = (y * width + x) * 4;
          
          // Gradiente horizontal
          const gx = 
            -1 * data[idx - 4 - width * 4] + 1 * data[idx + 4 - width * 4] +
            -2 * data[idx - 4] + 2 * data[idx + 4] +
            -1 * data[idx - 4 + width * 4] + 1 * data[idx + 4 + width * 4];
          
          // Gradiente vertical  
          const gy =
            -1 * data[idx - width * 4 - 4] + -2 * data[idx - width * 4] + -1 * data[idx - width * 4 + 4] +
             1 * data[idx + width * 4 - 4] +  2 * data[idx + width * 4] +  1 * data[idx + width * 4 + 4];
          
          const magnitude = Math.sqrt(gx * gx + gy * gy);
          edges[y * width + x] = Math.min(255, magnitude);
        }
      }
      
      return edges;
    }
    
    // Interceptar toDataURL
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      applyCanvasNoise(this);
      return originalToDataURL.apply(this, args);
    };
    
    // Interceptar toBlob
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(...args) {
      applyCanvasNoise(this);
      return originalToBlob.apply(this, args);
    };
    
    // Interceptar getImageData
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      applyCanvasNoise(this.canvas);
      return originalGetImageData.apply(this, args);
    };
    
    // Guardar referencias
    chameleonState.interceptors.set('canvas', {
      toDataURL: HTMLCanvasElement.prototype.toDataURL,
      toBlob: HTMLCanvasElement.prototype.toBlob,
      getImageData: CanvasRenderingContext2D.prototype.getImageData
    });
    
    console.log('[Chameleon] Canvas interceptor applied');
  }
  
  // WebGL Lazy Interceptor
  function setupWebGLLazyInterceptor() {
    let webglInterceptorApplied = false;
    
    // Interceptar creación de contexto WebGL
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = new Proxy(getContext, {
      apply(target, thisArg, args) {
        const contextType = args[0];
        
        if ((contextType === 'webgl' || contextType === 'webgl2' || contextType === 'experimental-webgl') && 
            !webglInterceptorApplied) {
          applyWebGLInterceptor();
          webglInterceptorApplied = true;
        }
        
        return Reflect.apply(target, thisArg, args);
      }
    });
    
    chameleonRegisterIntercepted(HTMLCanvasElement.prototype.getContext);
  }
  
  // WebGL Interceptor completo
  function applyWebGLInterceptor() {
    console.log('[Chameleon] Applying WebGL interceptor...');
    
    const profile = chameleonState.profile.webgl;
    
    // Interceptar getParameter para ambos contextos
    [WebGLRenderingContext, WebGL2RenderingContext].forEach(ContextClass => {
      if (!ContextClass) return;
      
      const originalGetParameter = ContextClass.prototype.getParameter;
      
      ContextClass.prototype.getParameter = new Proxy(originalGetParameter, {
        apply(target, thisArg, args) {
          const parameter = args[0];
          
          // Aplicar jitter
return applyJitter(() => {
            // Interceptar parámetros específicos
            switch (parameter) {
              case 0x9245: // UNMASKED_VENDOR_WEBGL
                return profile.vendor;
                
              case 0x9246: // UNMASKED_RENDERER_WEBGL
                return profile.renderer;
                
              case 0x1F00: // VENDOR
                return 'WebKit';
                
              case 0x1F01: // RENDERER
                return 'WebKit WebGL';
                
              case 0x1F02: // VERSION
                return profile.version;
                
              case 0x8B8C: // SHADING_LANGUAGE_VERSION
                return profile.shadingLanguageVersion;
                
              default:
                return Reflect.apply(target, thisArg, args);
            }
          });
        }
      });
      
      chameleonRegisterIntercepted(ContextClass.prototype.getParameter);
      
      // Interceptar getSupportedExtensions
      const originalGetSupportedExtensions = ContextClass.prototype.getSupportedExtensions;
      
      ContextClass.prototype.getSupportedExtensions = new Proxy(originalGetSupportedExtensions, {
        apply(target, thisArg, args) {
          return applyJitter(() => profile.extensions);
        }
      });
      
      chameleonRegisterIntercepted(ContextClass.prototype.getSupportedExtensions);
      
      // Interceptar getExtension
      const originalGetExtension = ContextClass.prototype.getExtension;
      
      ContextClass.prototype.getExtension = new Proxy(originalGetExtension, {
        apply(target, thisArg, args) {
          const name = args[0];
          
          return applyJitter(() => {
            if (profile.extensions.includes(name)) {
              return Reflect.apply(target, thisArg, args);
            }
            return null;
          });
        }
      });
      
      chameleonRegisterIntercepted(ContextClass.prototype.getExtension);
    });
    
    console.log('[Chameleon] WebGL interceptor applied');
  }
  
  // Audio Lazy Interceptor
  function setupAudioLazyInterceptor() {
    let audioInterceptorApplied = false;
    
    // Interceptar creación de AudioContext
    const AudioContexts = [
      window.AudioContext,
      window.webkitAudioContext,
      window.OfflineAudioContext,
      window.webkitOfflineAudioContext
    ].filter(Boolean);
    
    AudioContexts.forEach(AudioContextClass => {
      const OriginalAudioContext = AudioContextClass;
      
      window[AudioContextClass.name] = new Proxy(OriginalAudioContext, {
        construct(target, args) {
          if (!audioInterceptorApplied) {
            applyAudioInterceptor();
            audioInterceptorApplied = true;
          }
          
          return new target(...args);
        }
      });
    });
  }
  
  // Audio Interceptor completo
  function applyAudioInterceptor() {
    console.log('[Chameleon] Applying audio interceptor...');
    
    const profile = chameleonState.profile.audio;
    const rng = new Math.seedrandom(chameleonState.seed + 'audio');
    
    // Interceptar AnalyserNode.getFloatFrequencyData
    if (window.AnalyserNode) {
      const originalGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
      
      AnalyserNode.prototype.getFloatFrequencyData = new Proxy(originalGetFloatFrequencyData, {
        apply(target, thisArg, args) {
          return applyJitter(() => {
            // Obtener datos originales
            Reflect.apply(target, thisArg, args);
            
            const array = args[0];
            
            // Aplicar ruido determinista de baja amplitud
            for (let i = 0; i < array.length; i++) {
              // Generar ruido con características espectrales
              const freq = i / array.length;
              const noise = (rng() - 0.5) * profile.noise * (1 - freq * 0.5); // Menos ruido en altas frecuencias
              array[i] += noise;
            }
            
            return undefined;
          });
        }
      });
      
      chameleonRegisterIntercepted(AnalyserNode.prototype.getFloatFrequencyData);
      
      // Interceptar getByteFrequencyData también
      const originalGetByteFrequencyData = AnalyserNode.prototype.getByteFrequencyData;
      
      AnalyserNode.prototype.getByteFrequencyData = new Proxy(originalGetByteFrequencyData, {
        apply(target, thisArg, args) {
          return applyJitter(() => {
            Reflect.apply(target, thisArg, args);
            
            const array = args[0];
            
            for (let i = 0; i < array.length; i++) {
              const noise = Math.floor((rng() - 0.5) * 2);
              array[i] = Math.min(255, Math.max(0, array[i] + noise));
            }
            
            return undefined;
          });
        }
      });
      
      chameleonRegisterIntercepted(AnalyserNode.prototype.getByteFrequencyData);
    }
    
    // Interceptar AudioContext properties
    const AudioContexts = [AudioContext, webkitAudioContext].filter(Boolean);
    
    AudioContexts.forEach(AudioContextClass => {
      defineProperty(AudioContextClass.prototype, 'sampleRate', profile.sampleRate);
      
      // Interceptar createOscillator para añadir variación
      const originalCreateOscillator = AudioContextClass.prototype.createOscillator;
      
      AudioContextClass.prototype.createOscillator = new Proxy(originalCreateOscillator, {
        apply(target, thisArg, args) {
          const oscillator = Reflect.apply(target, thisArg, args);
          
          // Añadir una pequeña desafinación
          const originalFrequency = oscillator.frequency.value;
          defineProperty(oscillator.frequency, 'value', originalFrequency * (1 + (rng() - 0.5) * 0.0001));
          
          return oscillator;
        }
      });
      
      chameleonRegisterIntercepted(AudioContextClass.prototype.createOscillator);
    });
    
    console.log('[Chameleon] Audio interceptor applied');
  }
  
  // Timezone Interceptor
  function setupTimezoneInterceptor() {
    const profile = chameleonState.profile.timezone;
    
    // Interceptar Date methods
    const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = new Proxy(originalGetTimezoneOffset, {
      apply(target, thisArg, args) {
        return applyJitter(() => profile.offset);
      }
    });
    
    chameleonRegisterIntercepted(Date.prototype.getTimezoneOffset);
    
    // Interceptar Intl.DateTimeFormat
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    
    Intl.DateTimeFormat = new Proxy(OriginalDateTimeFormat, {
      construct(target, args) {
        // Modificar las opciones para forzar nuestra timezone
        const locale = args[0] || profile.locale;
        const options = args[1] || {};
        
        if (!options.timeZone) {
          options.timeZone = profile.name;
        }
        
        return new target(locale, options);
      }
    });
    
    // Interceptar resolvedOptions
    const originalResolvedOptions = OriginalDateTimeFormat.prototype.resolvedOptions;
    
    OriginalDateTimeFormat.prototype.resolvedOptions = new Proxy(originalResolvedOptions, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args);
        
        return applyJitter(() => {
          result.timeZone = profile.name;
          result.locale = profile.locale;
          return result;
        });
      }
    });
    
    chameleonRegisterIntercepted(OriginalDateTimeFormat.prototype.resolvedOptions);
    
    console.log('[Chameleon] Timezone interceptor applied');
  }
  
  // Battery Interceptor
  function setupBatteryInterceptor() {
    if ('getBattery' in navigator) {
      const profile = chameleonState.profile.battery;
      
      const originalGetBattery = navigator.getBattery;
      navigator.getBattery = new Proxy(originalGetBattery, {
        apply(target, thisArg, args) {
          return applyJitter(async () => {
            const battery = await Reflect.apply(target, thisArg, args);
            
            // Crear un proxy del objeto battery
            return new Proxy(battery, {
              get(target, prop) {
                switch (prop) {
                  case 'charging':
                    return profile.charging;
                  case 'chargingTime':
                    return profile.chargingTime;
                  case 'dischargingTime':
                    return profile.dischargingTime;
                  case 'level':
                    return profile.level;
                  default:
                    return target[prop];
                }
              }
            });
          });
        }
      });
      
      chameleonRegisterIntercepted(navigator.getBattery);
    }
  }
  
  // Función auxiliar para definir propiedades
  function defineProperty(obj, prop, value) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
    
    Object.defineProperty(obj, prop, {
      get: function() {
        return applyJitter(() => value);
      },
      set: descriptor && descriptor.set || function() {},
      enumerable: descriptor ? descriptor.enumerable : true,
      configurable: true
    });
    
    // Registrar el getter como interceptado
    const getter = Object.getOwnPropertyDescriptor(obj, prop).get;
    if (getter) {
      chameleonRegisterIntercepted(getter);
    }
  }
  
  // Crear PluginArray falso
  function createFakePluginArray(pluginsData) {
    const plugins = pluginsData.map(p => createFakePlugin(p));
    
    const fakePluginArray = {
      length: plugins.length,
      item: function(index) {
        return plugins[index] || null;
      },
      namedItem: function(name) {
        return plugins.find(p => p.name === name) || null;
      },
      refresh: function() {},
      [Symbol.iterator]: function*() {
        for (let i = 0; i < plugins.length; i++) {
          yield plugins[i];
        }
      },
      _chameleonFakeObject: true,
      _chameleonToStringTag: '[object PluginArray]'
    };
    
    // Agregar plugins por índice
    for (let i = 0; i < plugins.length; i++) {
      fakePluginArray[i] = plugins[i];
    }
    
    // Hacer que parezca un array real
    Object.setPrototypeOf(fakePluginArray, PluginArray.prototype);
    
    return fakePluginArray;
  }
  
  // Crear Plugin falso
  function createFakePlugin(pluginData) {
    const mimeTypes = pluginData.mimeTypes.map(m => createFakeMimeType(m, pluginData.name));
    
    const fakePlugin = {
      name: pluginData.name,
      description: pluginData.description,
      filename: pluginData.filename,
      length: mimeTypes.length,
      item: function(index) {
        return mimeTypes[index] || null;
      },
      namedItem: function(name) {
        return mimeTypes.find(m => m.type === name) || null;
      },
      [Symbol.iterator]: function*() {
        for (let i = 0; i < mimeTypes.length; i++) {
          yield mimeTypes[i];
        }
      },
      _chameleonFakeObject: true,
      _chameleonToStringTag: '[object Plugin]'
    };
    
    // Agregar mimeTypes por índice
    for (let i = 0; i < mimeTypes.length; i++) {
      fakePlugin[i] = mimeTypes[i];
    }
    
    Object.setPrototypeOf(fakePlugin, Plugin.prototype);
    
    return fakePlugin;
  }
  
  // Crear MimeTypeArray falso
  function createFakeMimeTypeArray(pluginsData) {
    const allMimeTypes = [];
    
    pluginsData.forEach(plugin => {
      plugin.mimeTypes.forEach(mimeType => {
        allMimeTypes.push(createFakeMimeType(mimeType, plugin.name));
      });
    });
    
    const fakeMimeTypeArray = {
      length: allMimeTypes.length,
      item: function(index) {
        return allMimeTypes[index] || null;
      },
      namedItem: function(name) {
        return allMimeTypes.find(m => m.type === name) || null;
      },
      [Symbol.iterator]: function*() {
        for (let i = 0; i < allMimeTypes.length; i++) {
          yield allMimeTypes[i];
        }
      },
      _chameleonFakeObject: true,
      _chameleonToStringTag: '[object MimeTypeArray]'
    };
    
    // Agregar mimeTypes por índice
    for (let i = 0; i < allMimeTypes.length; i++) {
      fakeMimeTypeArray[i] = allMimeTypes[i];
    }
    
    Object.setPrototypeOf(fakeMimeTypeArray, MimeTypeArray.prototype);
    
    return fakeMimeTypeArray;
  }
  
  // Crear MimeType falso
  function createFakeMimeType(mimeTypeData, pluginName) {
    const fakeMimeType = {
      type: mimeTypeData.type,
      suffixes: mimeTypeData.suffixes,
      description: mimeTypeData.description,
      enabledPlugin: pluginName,
      _chameleonFakeObject: true,
      _chameleonToStringTag: '[object MimeType]'
    };
    
    Object.setPrototypeOf(fakeMimeType, MimeType.prototype);
    
    return fakeMimeType;
  }
  
  // Aplicar jitter gaussiano
  function applyJitter(fn) {
    const jitterMs = generateGaussianJitter();
    
    if (jitterMs > 0) {
      return new Promise(resolve => {
        setTimeout(() => {
          resolve(fn());
        }, jitterMs);
      });
    }
    
    return fn();
  }
  
  // Generar jitter gaussiano
  function generateGaussianJitter() {
    const mean = 2; // 2ms promedio
    const stdDev = 1; // 1ms desviación estándar
    
    // Box-Muller transform
    const u1 = Math.random();
    const u2 = Math.random();
    
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const jitter = mean + z0 * stdDev;
    
    // Limitar entre 0 y 10ms
    return Math.max(0, Math.min(10, jitter));
  }
  
  // Verificar coherencia IP/VPN
  async function checkIPCoherence() {
    try {
      // Obtener información de IP actual
      const response = await fetch('https://ipapi.co/json/', { 
        cache: 'no-store',
        credentials: 'omit'
      });
      
      const ipData = await response.json();
      
      // Comparar con el perfil
      const profileTimezone = chameleonState.profile.timezone.name;
      const actualTimezone = ipData.timezone;
      
      if (profileTimezone !== actualTimezone) {
        console.warn('[Chameleon] Timezone mismatch detected!', {
          profile: profileTimezone,
          actual: actualTimezone,
          recommendation: 'Use VPN in matching location'
        });
        
        // Guardar estado para mostrar en UI
        chameleonState.vpnStatus = {
          coherent: false,
          message: `Timezone mismatch: Profile says ${profileTimezone} but IP shows ${actualTimezone}`,
          severity: 'warning'
        };
      } else {
        chameleonState.vpnStatus = {
          coherent: true,
          message: 'IP location matches profile',
          severity: 'success'
        };
      }
      
      // Detectar VPN
      const vpnIndicators = [
        ipData.org?.toLowerCase().includes('vpn'),
        ipData.org?.toLowerCase().includes('proxy'),
        ipData.org?.toLowerCase().includes('hosting'),
        ipData.org?.toLowerCase().includes('datacenter')
      ];
      
      if (vpnIndicators.some(indicator => indicator === true)) {
        chameleonState.vpnStatus.isVPN = true;
        chameleonState.vpnStatus.vpnType = ipData.org;
      }
      
    } catch (error) {
      console.error('[Chameleon] Failed to check IP coherence:', error);
    }
  }
  
  // Cargar librería seedrandom
  function loadSeedrandom() {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('lib/seedrandom.min.js');
      script.onload = resolve;
      document.head.appendChild(script);
    });
  }
  
  // Esperar a que seedrandom esté disponible
  async function waitForSeedrandom() {
    if (typeof Math.seedrandom === 'undefined') {
      await loadSeedrandom();
      
      // Esperar un poco más para asegurar que se cargó
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  // Inicializar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    waitForSeedrandom().then(initialize);
  } else {
    waitForSeedrandom().then(initialize);
  }
  
})();