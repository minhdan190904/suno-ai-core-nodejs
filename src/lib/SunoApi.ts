import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import path from 'node:path';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const DEFAULT_MODEL = 'chirp-auk-turbo';

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any; // You can define a more specific type if needed
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any; // You can define a more specific type if needed
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api.prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.117.0';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private cursor?: Cursor;
  // Token được lưu sau pre-warm để generate() dùng lại mà không cở browser
  private cachedCaptchaToken?: string;
  private cachedCaptchaTokenAt?: number; // timestamp ms
  private static TOKEN_TTL_MS = 2 * 60 * 1000; // Cloudflare Turnstile token có TTL ngắn hơn hCaptcha (~2-3 phút)

  constructor(cookies: string) {
    this.userAgent = new UserAgent(/Macintosh/).random().toString(); // Usually Mac systems get less amount of CAPTCHAs
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Device-Id': this.deviceId,
        'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) => 
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const newCookies = cookie.parse(setCookieHeader.join('; '));
        for (const [key, value] of Object.entries(newCookies)) {
          this.cookies[key] = value;
        }
      }
      return resp;
    })
  }

  public async init(): Promise<SunoApi> {
    //await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the clerk package latest version id.
   * This method is commented because we are now using a hard-coded Clerk version, hence this method is not needed.
   
  private async getClerkLatestVersion() {
    // URL to get clerk version ID
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`;
    // Get clerk version ID
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.['tags']['latest']) {
      throw new Error(
        'Failed to get clerk version info, Please try again later'
      );
    }
    // Save clerk version ID for auth
    SunoApi.clerkVersion = versionListResponse?.data?.['tags']['latest'];
  }
  */

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    logger.info('Getting the session ID');
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Renew session token
    logger.info('KeepAlive...\n');
    const renewResponse = await this.client.post(renewUrl, {}, {
      headers: { Authorization: this.cookies.__client }
    });
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data.jwt;
    // Update Authorization field in request header with the new JWT token
    this.currentToken = newToken;
  }

  /**
   * Get the session token (not to be confused with session ID) and save it for later use.
   */
  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  public async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    logger.info(resp.data);
    return resp.data.required;
  }

  /**
   * Clicks on a locator or XY vector. This method is made because of the difference between ghost-cursor-playwright and Playwright methods
   */
  private async click(target: Locator|Page, position?: { x: number, y: number }): Promise<void> {
    if (this.ghostCursorEnabled) {
      let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
      if (position) 
        pos = {
          ...pos,
          x: pos.x + position.x,
          y: pos.y + position.y,
          width: null,
          height: null,
        };
      return this.cursor?.actions.click({
        target: pos
      });
    } else {
      if (isPage(target))
        return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
      else
        return target.click({ force: true, position });
    }
  }

  /**
   * Get the BrowserType from the `BROWSER` environment variable.
   * @returns {BrowserType} chromium, firefox or webkit. Default is chromium
   */
  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      /*case 'webkit': ** doesn't work with rebrowser-patches
      case 'safari':
        return webkit;*/
      default:
        return chromium;
    }
  }

  /**
   * Launches a browser with the necessary cookies
   * @returns {BrowserContext}
   */
  private async launchBrowser(): Promise<BrowserContext> {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Combine into one --disable-features (Chrome only reads the last one)
      '--disable-features=site-per-process,IsolateOrigins,CrossOriginEmbedderPolicy,CrossOriginOpenerPolicy',
      '--disable-extensions',
      '--disable-infobars',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--password-store=basic',
      '--use-mock-keychain',
      '--force-color-profile=srgb',
      '--window-size=1920,1080',
    ];
    // Check for GPU acceleration, as it is recommended to turn it off for Docker
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
      args.push('--enable-unsafe-swiftshader',
        '--disable-gpu',
        '--disable-setuid-sandbox');

    logger.info('[launchBrowser] Launching browser (headless=' + yn(process.env.BROWSER_HEADLESS, { default: true }) + ')');
    const browser = await this.getBrowserType().launch({
      args,
      headless: yn(process.env.BROWSER_HEADLESS, { default: true })
    });
    logger.info('[launchBrowser] Browser launched successfully');

    const context = await browser.newContext({
      userAgent: this.userAgent,
      locale: process.env.BROWSER_LOCALE,
      viewport: { width: 1920, height: 1080 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    logger.info('[launchBrowser] Browser context created. userAgent=' + this.userAgent);

    // Inject anti-detection scripts before any page loads (runs in every frame including hCaptcha iframe)
    await context.addInitScript(`
      // Hide navigator.webdriver (primary headless detection vector)
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

      // Override navigator.userAgentData to hide HeadlessChrome
      if (navigator.userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => ({
            brands: [
              { brand: 'Google Chrome', version: '131' },
              { brand: 'Chromium', version: '131' },
              { brand: 'Not_A Brand', version: '24' },
            ],
            mobile: false,
            platform: 'macOS',
            getHighEntropyValues: (hints) => Promise.resolve({
              brands: [
                { brand: 'Google Chrome', version: '131' },
                { brand: 'Chromium', version: '131' },
                { brand: 'Not_A Brand', version: '24' },
              ],
              fullVersionList: [
                { brand: 'Google Chrome', version: '131.0.6778.33' },
                { brand: 'Chromium', version: '131.0.6778.33' },
                { brand: 'Not_A Brand', version: '24.0.0.0' },
              ],
              mobile: false,
              model: '',
              platform: 'macOS',
              platformVersion: '10.15.7',
              architecture: 'x86',
              bitness: '64',
              wow64: false,
            }),
            toJSON: () => ({
              brands: [
                { brand: 'Google Chrome', version: '131' },
                { brand: 'Chromium', version: '131' },
                { brand: 'Not_A Brand', version: '24' },
              ],
              mobile: false,
              platform: 'macOS',
            }),
          }),
        });
      }

      // Fake plugins array (headless has empty plugins)
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const arr = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
          ];
          arr.length = 3;
          return arr;
        },
      });

      // Override navigator.languages
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

      // Add chrome runtime object (missing in headless)
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = {};

      // Override permissions query
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(params);
    `);
    logger.info('[launchBrowser] Anti-detection init scripts injected');

    const cookies = [];
    const lax: 'Lax' | 'Strict' | 'None' = 'Lax';
    cookies.push({
      name: '__session',
      value: this.currentToken+'',
      domain: '.suno.com',
      path: '/',
      sameSite: lax
    });
    for (const key in this.cookies) {
      cookies.push({
        name: key,
        value: this.cookies[key]+'',
        domain: '.suno.com',
        path: '/',
        sameSite: lax
      })
    }
    await context.addCookies(cookies);
    logger.info('[launchBrowser] Cookies injected: ' + cookies.map(c => c.name).join(', '));
    return context;
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed.
   * Suno uses hCaptcha for generate actions (served from hcaptcha-assets-prod.suno.com).
   * Cloudflare Turnstile handles page-level auth (passes automatically via Clerk).
   * @returns {string|null} hCaptcha token. If no verification is required, returns null
   */
  public async getCaptcha(): Promise<string|null> {
    const captchaStartMs = Date.now();
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('[getCaptcha] 🔐 Bắt đầu quy trình xác minh CAPTCHA');
    logger.info('[getCaptcha] Thời điểm bắt đầu: ' + new Date().toISOString());
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // ✔ Kiểm tra token đã pre-warm trước đó còn hiệu lực không (< 4 phút)
    if (this.cachedCaptchaToken && this.cachedCaptchaTokenAt) {
      const age = Date.now() - this.cachedCaptchaTokenAt;
      if (age < SunoApi.TOKEN_TTL_MS) {
        logger.info(`[getCaptcha] ⚡ Dùng cached token từ pre-warm (${Math.round(age/1000)}s tuổi, còn hiệu lực ${Math.round((SunoApi.TOKEN_TTL_MS - age)/1000)}s). Bỏ qua browser!`);
        const token = this.cachedCaptchaToken;
        this.cachedCaptchaToken = undefined;
        this.cachedCaptchaTokenAt = undefined;
        return token;
      } else {
        logger.info(`[getCaptcha] ⏰ Cached token đã hết hạn (${Math.round(age/1000)}s tuổi). Tiếp tục lấy token mới...`);
        this.cachedCaptchaToken = undefined;
        this.cachedCaptchaTokenAt = undefined;
      }
    }

    logger.info('[getCaptcha] [1/6] Kiểm tra xem có cần CAPTCHA không (/api/c/check)...');
    const checkStart = Date.now();
    const captchaNeeded = await this.captchaRequired();
    logger.info(`[getCaptcha] Kết quả kiểm tra: captchaRequired=${captchaNeeded} (${Date.now() - checkStart}ms)`);
    if (!captchaNeeded) {
      logger.info('[getCaptcha] ✅ Không cần CAPTCHA, bỏ qua browser flow. Tổng thời gian: ' + (Date.now() - captchaStartMs) + 'ms');
      return null;
    }
    logger.info('[getCaptcha] ⚠️  CAPTCHA BẮT BUỘC — Sẽ mở browser Playwright để giải CAPTCHA...');

    logger.info('[getCaptcha] [2/6] Khởi động browser Playwright...');
    const browserLaunchStart = Date.now();
    const browserCtx = await this.launchBrowser();
    const page = await browserCtx.newPage();
    logger.info(`[getCaptcha] ✅ Browser đã khởi động (${Date.now() - browserLaunchStart}ms). UserAgent: ${this.userAgent?.substring(0, 60)}...`);

    // Override User-Agent Client Hints at network level via CDP to hide HeadlessChrome
    try {
      const cdpSession = await browserCtx.newCDPSession(page);
      await cdpSession.send('Network.setUserAgentOverride', {
        userAgent: this.userAgent!,
        userAgentMetadata: {
          brands: [
            { brand: 'Google Chrome', version: '131' },
            { brand: 'Chromium', version: '131' },
            { brand: 'Not_A Brand', version: '24' },
          ],
          fullVersionList: [
            { brand: 'Google Chrome', version: '131.0.6778.33' },
            { brand: 'Chromium', version: '131.0.6778.33' },
            { brand: 'Not_A Brand', version: '24.0.0.0' },
          ],
          fullVersion: '131.0.6778.33',
          platform: 'macOS',
          platformVersion: '10.15.7',
          architecture: 'x86',
          model: '',
          mobile: false,
          bitness: '64',
          wow64: false,
        },
      });
      logger.info('[getCaptcha] CDP: User-Agent Client Hints overridden (HeadlessChrome -> Google Chrome)');
    } catch (e: any) {
      logger.warn('[getCaptcha] CDP Client Hints override failed: ' + e.message);
    }

    // Shared callback: called by CSP handler when /api/generate/v2 is intercepted
    let onGenerateIntercepted: ((route: any) => void) | null = null;

    // Strip CSP/COEP headers from Suno pages to allow hCaptcha iframe embedding.
    // CRITICAL rules:
    //   1. DO NOT intercept hCaptcha/captcha resources — they must load freely from
    //      hcaptcha-assets-prod.suno.com (route.fetch() fails in iframe context = ERR_ABORTED)
    //   2. DO NOT intercept challenges.cloudflare.com — Turnstile must work freely
    //   3. DO intercept /api/generate/v2 to capture the hCaptcha token
    const stripCspHandler = async (route: any) => {
      const url = route.request().url();

      // *** PRIORITY 1: Intercept generate/v2 to capture hCaptcha token ***
      if (url.includes('/api/generate/v2')) {
        logger.info(`[getCaptcha:CSP] 🎯 CHẶN request generate/v2: ${url.substring(0, 100)}`);
        if (onGenerateIntercepted) {
          onGenerateIntercepted(route);
        } else {
          logger.warn('[getCaptcha:CSP] onGenerateIntercepted chưa sẵn sàng, abort trực tiếp.');
          await route.abort();
        }
        return;
      }

      // *** PRIORITY 2: Pass hCaptcha resources through WITHOUT route.fetch() ***
      // hCaptcha is now served from hcaptcha-assets-prod.suno.com (Suno's own CDN).
      // Calling route.fetch() for these iframe resources fails with ERR_ABORTED.
      // Must use route.continue() instead to let them load freely.
      if (url.includes('hcaptcha') || url.includes('/captcha/')) {
        try { await route.continue(); } catch { /* ignore — request may already be gone */ }
        return;
      }

      // *** PRIORITY 3: Strip CSP headers from Suno pages ***
      try {
        const response = await route.fetch();
        const headers = { ...response.headers() };
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        delete headers['cross-origin-embedder-policy'];
        delete headers['cross-origin-opener-policy'];

        // Also strip <meta> CSP tags from HTML responses (hCaptcha embeds CSP in HTML)
        const contentType = headers['content-type'] || '';
        if (contentType.includes('text/html')) {
          let body = await response.text();
          body = body.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
          await route.fulfill({ headers, body, status: response.status() });
        } else {
          await route.fulfill({ response, headers });
        }
      } catch {
        await route.continue();
      }
    };
    // Route Suno pages for CSP stripping + generate interception.
    // DO NOT route challenges.cloudflare.com (Turnstile must work freely).
    await page.route('https://suno.com/**', stripCspHandler);
    await page.route('https://*.suno.com/**', stripCspHandler);
    logger.info('[getCaptcha] Routes đã đăng ký:');
    logger.info('[getCaptcha]   • suno.com/** + *.suno.com/** → CSP strip (trừ hcaptcha URLs → continue)');
    logger.info('[getCaptcha]   • challenges.cloudflare.com → KHÔNG route (Turnstile tự do)');
    logger.info('[getCaptcha] ✅ Generate/v2 interception tích hợp trong CSP handler.');

    // ── Verbose browser event logging ──
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') logger.error('[browser:console:ERROR] ' + text);
      else if (type === 'warning' || type === 'warn') logger.warn('[browser:console:WARN] ' + text);
    });
    page.on('pageerror', err => logger.error('[browser:pageerror] ❌ ' + err.message));
    page.on('requestfailed', req => {
      const failUrl = req.url();
      // Only log failures from important domains, skip Cloudflare Turnstile noise
      if (!failUrl.includes('challenges.cloudflare.com') && !failUrl.includes('hagen.challenges')) {
        logger.warn('[browser:requestfailed] ⚠️  ' + req.method() + ' ' + failUrl.substring(0, 120) + ' -> ' + req.failure()?.errorText);
      }
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        logger.info('[browser:navigation] 🔀 Trang chuyển sang: ' + frame.url().substring(0, 150));
      }
    });
    page.on('response', resp => {
      const url = resp.url();
      const status = resp.status();
      if (url.includes('/api/c/check') || url.includes('/api/project') ||
          url.includes('/api/generate') || url.includes('clerk') ||
          url.includes('hcaptcha') || url.includes('turnstile')) {
        const emoji = status >= 400 ? '❌' : '✅';
        logger.info(`[browser:response] ${emoji} ${status} ${resp.request().method()} ${url.substring(0, 140)}`);
      }
    });

    logger.info('[getCaptcha] [3/6] Điều hướng đến https://suno.com/create ...');
    const gotoStart = Date.now();
    try {
      await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });
      logger.info(`[getCaptcha] ✅ Trang đã tải (domcontentloaded) sau ${Date.now() - gotoStart}ms`);
      logger.info('[getCaptcha] URL hiện tại: ' + page.url());
    } catch (e: any) {
      logger.error('[getCaptcha] ❌ page.goto thất bại sau ' + (Date.now() - gotoStart) + 'ms: ' + e.message);
      throw e;
    }

    logger.info('[getCaptcha] [4/6] Chờ Suno project API response (**/api/project/**) — tối đa 60s...');
    const projectApiStart = Date.now();
    try {
      const projectResp = await page.waitForResponse('**/api/project/**\\?**', { timeout: 60000 });
      logger.info(`[getCaptcha] ✅ Project API response nhận được sau ${Date.now() - projectApiStart}ms`);
      logger.info('[getCaptcha] Project API status: ' + projectResp.status() + ' | URL: ' + projectResp.url().substring(0, 120));
      logger.info('[getCaptcha] Giao diện Suno đã sẵn sàng.');
    } catch (e: any) {
      logger.error(`[getCaptcha] ❌ waitForResponse timeout sau ${Date.now() - projectApiStart}ms: ` + e.message);
      try {
        const screenshotPath = path.join(process.cwd(), 'public', 'debug-project-api-timeout.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info('[getCaptcha] Screenshot đã lưu: ' + screenshotPath);
      } catch (ssErr: any) {
        logger.warn('[getCaptcha] Không thể lưu screenshot: ' + ssErr.message);
      }
      throw e;
    }

    // Wait for page to stabilize after Clerk handshake
    logger.info('[getCaptcha] [5/6] Chờ trang ổn định...');
    const settleStart = Date.now();
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
    } catch { /* ignore timeout */ }
    const currentUrl = page.url();
    if (currentUrl.includes('__clerk_handshake') || currentUrl.includes('clerk')) {
      logger.info('[getCaptcha] 🔄 Phát hiện Clerk redirect, đang chờ navigation cuối cùng...');
      try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
        logger.info('[getCaptcha] ✅ Navigation sau Clerk redirect hoàn thành. URL: ' + page.url());
      } catch { /* ignore timeout */ }
    }
    await sleep(0.2, 0.3);
    logger.info(`[getCaptcha] ✅ Trang ổn định sau ${Date.now() - settleStart}ms. URL: ` + page.url());

    if (this.ghostCursorEnabled) {
      this.cursor = await createCursor(page);
      logger.info('[getCaptcha] Ghost cursor initialized.');
    }

    // Close any popup
    try {
      const closeButtons = page.getByLabel('Close');
      const closeCount = await closeButtons.count().catch(() => 0);
      if (closeCount > 0) {
        await closeButtons.first().click({ timeout: 2000 });
        logger.info('[getCaptcha] ✅ Đã đóng popup.');
      }
    } catch { /* ignore */ }

    // Wait for textarea to be ready
    logger.info('[getCaptcha] [6/6] Tìm textarea và click Create để trigger Turnstile...');
    const textarea = page.locator('textarea:visible');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await textarea.waitFor({ state: 'visible', timeout: 15000 });
        logger.info(`[getCaptcha] ✅ Textarea visible (attempt ${attempt}/3)`);
        break;
      } catch (e: any) {
        const isNavError = e.message.includes('Execution context was destroyed')
          || e.message.includes('navigation')
          || e.message.includes('detached');
        if (isNavError && attempt < 3) {
          try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch (_) {}
          await sleep(0.5, 1);
        } else {
          // Save debug info
          try {
            const html = await page.content();
            await fs.writeFile(path.join(process.cwd(), 'public', 'debug-page-content.html'), html);
          } catch { /* ignore */ }
          try {
            await page.screenshot({ path: path.join(process.cwd(), 'public', 'debug-textarea-not-found.png'), fullPage: true });
          } catch { /* ignore */ }
          throw e;
        }
      }
    }

    await this.click(textarea);
    const dummyPrompts = [
      'A beautiful pop song about a sunny day',
      'Epic orchestral battle music',
      'Lo-fi hip hop beats to relax to',
      'An upbeat electronic dance track',
      'A sad acoustic song about heartbreak',
      'A rock song about driving on the highway',
      'Soothing jazz for late night studying'
    ];
    const randomPrompt = dummyPrompts[Math.floor(Math.random() * dummyPrompts.length)];
    await textarea.pressSequentially(randomPrompt, { delay: 20 });
    logger.info(`[getCaptcha] ✅ Đã nhập text mồi vào textarea: "${randomPrompt}"`);

    // Click Create button — this triggers hCaptcha challenge
    const button = page.locator('button[aria-label*="Create"]');
    try {
      const btnCount = await button.count();
      logger.info('[getCaptcha] Số nút Create tìm thấy: ' + btnCount);
      for (let i = 0; i < Math.min(btnCount, 3); i++) {
        const ariaLabel = await button.nth(i).getAttribute('aria-label').catch(() => '?');
        const isDisabled = await button.nth(i).isDisabled().catch(() => false);
        logger.info(`[getCaptcha] Nút Create #${i+1}: aria-label="${ariaLabel}" | disabled=${isDisabled}`);
      }
    } catch (e: any) {
      logger.warn('[getCaptcha] Không đếm được nút Create: ' + e.message);
    }
    logger.info('[getCaptcha] 🖱️  Đang click nút Create để trigger hCaptcha...');
    await this.click(button);
    logger.info('[getCaptcha] ✅ Đã click nút Create. hCaptcha sẽ xuất hiện...');

    // Log frames + screenshot after clicking to verify hCaptcha appears
    await sleep(1.5, 2);
    try {
      const allFramesPostClick = page.frames();
      const hcaptchaFrames = allFramesPostClick.filter((f: any) => f.url().includes('hcaptcha'));
      const turnstileFrames = allFramesPostClick.filter((f: any) => f.url().includes('challenges.cloudflare.com'));
      logger.info(`[getCaptcha] Frames sau click Create: total=${allFramesPostClick.length}, hcaptcha=${hcaptchaFrames.length}, turnstile=${turnstileFrames.length}`);
      allFramesPostClick.forEach((f: any, i: number) => logger.info(`  Frame #${i}: ${f.url().substring(0, 120)}`));
      const debugPath = path.join(process.cwd(), 'public', 'debug-after-create-click.png');
      await page.screenshot({ path: debugPath, fullPage: true });
      logger.info('[getCaptcha] 📸 Screenshot sau click Create: ' + debugPath);
    } catch (ssErr: any) {
      logger.warn('[getCaptcha] Debug info thất bại: ' + ssErr.message);
    }

    const controller = new AbortController();
    const challengeStartMs = Date.now();
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('[getCaptcha] [10/10] 🤖 Bắt đầu vòng lặp giải CAPTCHA (2Captcha)...');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    let challengeRound = 0;
    let resolveTokenPromise: (value: string | null | PromiseLike<string | null>) => void;
    let rejectTokenPromise: (reason?: any) => void;
    
    // CAPTCHA solving loop — runs in parallel with tokenPromise.
    // Handles both hCaptcha (coordinates) and Cloudflare Turnstile (token injection).
    new Promise<void>(async (resolve, reject) => {
      try {
        let wait = true;
        let firstIteration = true;
        
        while (true) {
          if (wait) {
            if (firstIteration) {
              logger.info('[getCaptcha:loop] ⏳ Chờ hCaptcha hoặc Turnstile challenge xuất hiện (tối đa 3 phút)...');
              
              // Wait until either an hCaptcha container OR a visible Turnstile iframe appears
              const waitChallengeStart = Date.now();
              let foundCaptcha = false;
              while (Date.now() - waitChallengeStart < 180000) {
                const hasHcaptcha = await page.frameLocator('iframe[title*="hCaptcha"]').locator('.challenge-container').isVisible().catch(() => false);
                
                let hasTurnstile = false;
                try {
                  const tsFrames = page.frames().filter(f => f.url().includes('challenges.cloudflare.com'));
                  for (const f of tsFrames) {
                    if (f.url().match(/([0-9]x4[A-Za-z0-9_-]{15,})/)) {
                      hasTurnstile = true; break;
                    }
                  }
                } catch (e) { /* ignore */ }
                
                if (hasHcaptcha || hasTurnstile) {
                  foundCaptcha = true;
                  break;
                }
                await sleep(1);
              }
              
              if (!foundCaptcha) {
                logger.warn('[getCaptcha:loop] ⏰ Không thấy CAPTCHA nào xuất hiện sau 3 phút.');
                break;
              }
              logger.info(`[getCaptcha:loop] ✅ Challenge đã xuất hiện sau ${Date.now() - waitChallengeStart}ms.`);
              await sleep(0.5, 1);
              firstIteration = false;
            } else {
              logger.info('[getCaptcha:loop] Chờ network settle (tối đa 12s)...');
              await Promise.race([
                waitForRequests(page, controller.signal),
                new Promise<void>(r => setTimeout(r, 12000))
              ]);
            }
          }
          challengeRound++;
          const roundStart = Date.now();
          
          // Check which CAPTCHA is currently visible
          const hFrame = page.frameLocator('iframe[title*="hCaptcha"]');
          const isHcaptcha = await hFrame.locator('.challenge-container').isVisible().catch(() => false);
          
          // Find the Turnstile frame from page.frames()
          let tsFrameObj: any = null;
          let tsUrl: string | null = null;
          try {
            const tsFrames = page.frames().filter(f => f.url().includes('challenges.cloudflare.com'));
            for (const f of tsFrames) {
              if (f.url().match(/([0-9]x4[A-Za-z0-9_-]{15,})/)) {
                tsFrameObj = f;
                tsUrl = f.url();
                break;
              }
            }
          } catch(e) {}
          const isTurnstile = !!tsFrameObj;
          
          if (isTurnstile) {
            logger.info(`[getCaptcha:loop] ── Round ${challengeRound} (Cloudflare Turnstile) ───────────`);
            logger.info('[getCaptcha:loop] 🛡️ Phát hiện Cloudflare Turnstile interactive challenge.');
            
            // Extract Sitekey from Turnstile iframe URL
            // The sitekey always starts with 0x4 or 1x4, 2x4, etc., and is around 22 chars long.
            const match = tsUrl ? tsUrl.match(/([0-9]x4[A-Za-z0-9_-]{15,})/) : null;
            const sitekey = match ? match[1] : null;
            
            if (!sitekey) {
               logger.warn('[getCaptcha:loop] ❌ Không lấy được sitekey từ URL Turnstile: ' + tsUrl);
               // Fallback: try to find the frame and click it
               logger.info('[getCaptcha:loop] Thử fallback bằng cách click trực tiếp vào Turnstile iframe...');
               try {
                  const loc = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
                  await this.click(loc);
               } catch(e) {}
               await sleep(5, 7);
               wait = true;
               firstIteration = true;
               continue;
            }
            
            logger.info(`[getCaptcha:loop] 🔑 Đã lấy được Sitekey Turnstile: ${sitekey}`);
            logger.info('[getCaptcha:loop] 📤 Gửi request giải Turnstile lên 2Captcha...');
            const solveStart = Date.now();
            let captcha: any;
            try {
              captcha = await this.solver.cloudflareTurnstile({
                pageurl: page.url(),
                sitekey: sitekey,
                action: 'generate' // Optional action parameter
              });
              logger.info(`[getCaptcha:loop] ✅ 2Captcha giải thành công Turnstile sau ${Date.now() - solveStart}ms`);
              logger.info(`[getCaptcha:loop] Token length: ${captcha?.data?.length}`);
            } catch (err: any) {
              logger.error(`[getCaptcha:loop] ❌ 2Captcha Turnstile error: ${err.message}`);
              wait = true;
              firstIteration = true;
              continue;
            }
            
            logger.info('[getCaptcha:loop] ✅ Đã có Token Turnstile từ 2Captcha, trả về trực tiếp mà không cần inject!');
            browserCtx.browser()?.close();
            controller.abort();
            
            if (captcha.data) {
                this.setCaptchaToken(captcha.data); // Caching it for prewarm route logic!
            }

            if (resolveTokenPromise) resolveTokenPromise(captcha.data);
            resolve(captcha.data);
            return;
          }
          
          if (isHcaptcha) {
            const challenge = hFrame.locator('.challenge-container');
            const promptText = (await challenge.locator('.prompt-text').first().innerText()).toLowerCase();
            const challengeType = promptText.includes('drag') ? 'DRAG' : 'CLICK';
            logger.info(`[getCaptcha:loop] ── Round ${challengeRound} (hCaptcha) ─────────────────────────`);
          logger.info(`[getCaptcha:loop] Loại challenge: ${challengeType}`);
          logger.info(`[getCaptcha:loop] Nội dung prompt: "${promptText}"`);
          logger.info(`[getCaptcha:loop] Thời gian kể từ lần click Create: ${Date.now() - challengeStartMs}ms`);
          const drag = promptText.includes('drag');
          let captcha: any;
          for (let j = 0; j < 3; j++) {
            try {
              logger.info(`[getCaptcha:loop] 📤 Gửi screenshot lên 2Captcha (lần ${j+1}/3)...`);
              const screenshotBuf = await challenge.screenshot({ timeout: 5000 });
              logger.info(`[getCaptcha:loop] Screenshot kích thước: ${screenshotBuf.length} bytes (${Math.round(screenshotBuf.length/1024)}KB)`);
              const payload: paramsCoordinates = {
                body: screenshotBuf.toString('base64'),
                lang: process.env.BROWSER_LOCALE
              };
              if (drag) {
                payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
                payload.imginstructions = (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64');
              }
              const solveStart = Date.now();
              captcha = await this.solver.coordinates(payload);
              logger.info(`[getCaptcha:loop] ✅ 2Captcha trả lời sau ${Date.now() - solveStart}ms`);
              logger.info(`[getCaptcha:loop] Captcha ID: ${captcha?.id}`);
              logger.info(`[getCaptcha:loop] Số điểm cần click: ${captcha?.data?.length}`);
              logger.info(`[getCaptcha:loop] Tọa độ: ${JSON.stringify(captcha?.data)}`);
              break;
            } catch(err: any) {
              logger.error('[getCaptcha:loop] 2Captcha error (attempt ' + (j+1) + '): ' + err.message);
              if (j != 2)
                logger.info('[getCaptcha:loop] Retrying...');
              else
                throw err;
            }
          }
          if (drag) {
            logger.info('[getCaptcha:loop] Drag challenge detected. Getting bounding box...');
            const challengeBox = await challenge.boundingBox();
            if (challengeBox == null)
              throw new Error('.challenge-container boundingBox is null!');
            logger.info('[getCaptcha:loop] challengeBox: ' + JSON.stringify(challengeBox));
            if (captcha.data.length % 2) {
              logger.info('[getCaptcha:loop] Solution does not have even amount of points required for dragging. Requesting new solution...');
              this.solver.badReport(captcha.id);
              wait = false;
              continue;
            }
            for (let i = 0; i < captcha.data.length; i += 2) {
              const data1 = captcha.data[i];
              const data2 = captcha.data[i+1];
              logger.info('[getCaptcha:loop] Drag: ' + JSON.stringify(data1) + ' -> ' + JSON.stringify(data2));
              await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
              await page.mouse.down();
              await sleep(1.1);
              await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, { steps: 30 });
              await page.mouse.up();
            }
            wait = true;
          } else {
            logger.info(`[getCaptcha:loop] 🖱️  Click challenge: ${captcha?.data?.length} điểm cần click`);
            for (let ci = 0; ci < captcha.data.length; ci++) {
              const data = captcha.data[ci];
              logger.info(`[getCaptcha:loop] Click điểm ${ci+1}/${captcha.data.length}: x=${data.x}, y=${data.y}`);
              await this.click(challenge, { x: +data.x, y: +data.y });
              logger.info(`[getCaptcha:loop] ✅ Đã click điểm ${ci+1}`);
            }
          }
          logger.info(`[getCaptcha:loop] Round ${challengeRound} hoàn thành sau ${Date.now() - roundStart}ms. Đang Submit...`);
          logger.info('[getCaptcha:loop] Clicking Submit button...');
          this.click(hFrame.locator('.button-submit')).catch(e => {
            if (e.message.includes('viewport')) {
              logger.info('[getCaptcha:loop] Submit button out of viewport, re-clicking Create button...');
              this.click(button);
            } else {
              throw e;
            }
          });
          } // end isHcaptcha
        } // end while(true)
      } catch(e: any) {
        if (e.message.includes('been closed') || e.message === 'AbortError' || e.message.includes('Timeout') || e.message.includes('Target page, context or browser has been closed')) {
          logger.info(`[getCaptcha:loop] Vòng lặp CAPTCHA kết thúc bình thường sau ${challengeRound} round(s). Lý do: ${e.message.substring(0, 80)}`);
          resolve();
        } else {
          logger.error('[getCaptcha:loop] ❌ Lỗi nghiêm trọng trong vòng lặp CAPTCHA: ' + e.message);
          reject(e);
        }
      }
    }).catch(e => {
      logger.error('[getCaptcha] CAPTCHA Promise rejected: ' + e.message);
      try {
        const crashPath = path.join(process.cwd(), 'public', 'debug-captcha-crash.png');
        page.screenshot({ path: crashPath, fullPage: true }).catch(() => {});
      } catch {}
      browserCtx.browser()?.close();
      logger.warn('[getCaptcha] Captcha failed, will try generate without token (graceful fallback)');
    });

    // Token is extracted from the intercepted /api/generate/v2 request that fires after hCaptcha is solved.
    // This callback is assigned here and invoked by stripCspHandler.
    logger.info('[getCaptcha] ⏳ Đăng ký generate intercept callback...');
    const tokenWaitStart = Date.now();

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const tokenPromise = new Promise<string|null>((resolve, reject) => {
      resolveTokenPromise = resolve;
      rejectTokenPromise = reject;
      // Gán callback — sẽ được gọi bời CSP handler khi URL chứa /api/generate/v2
      onGenerateIntercepted = async (route: any) => {
        try {
          const elapsed = Date.now() - tokenWaitStart;
          const url = route.request().url();
          logger.info(`[getCaptcha] 🎯 Đã intercept ${url} sau ${elapsed}ms!`);
          const request = route.request();
          const postData = request.postDataJSON();
          const token = postData?.token;
          const tokenProvider = postData?.token_provider;
          const authHeader = request.headers().authorization || '';
          // ABORT FIRST — trước mọi thứ để ngăn Suno tạo bài hát mồi
          await route.abort();
          logger.info(`[getCaptcha] ✅ ROUTE ABORTED — request KHÔNG đến Suno server!`);
          logger.info(`[getCaptcha] Token provider: ${tokenProvider ?? '(none)'}`);
          logger.info(`[getCaptcha] Token hCaptcha: ${token ? token.substring(0, 30) + '...' : 'KHÔNG CÓ'}`);
          logger.info(`[getCaptcha] Token length: ${token?.length ?? 0} ký tự`);
          logger.info(`[getCaptcha] Authorization header: ${authHeader.substring(0, 50)}...`);
          logger.info(`[getCaptcha] Payload keys: ${Object.keys(postData || {}).join(', ')}`);
          logger.info('[getCaptcha] Route đã abort — bài hát mồi sẽ KHÔNG được tạo.');
          this.currentToken = authHeader.split('Bearer ').pop();
          browserCtx.browser()?.close();
          controller.abort();
          // Clear timeout to prevent misleading 'Timeout' log
          if (timeoutId) clearTimeout(timeoutId);
          const totalElapsed = Date.now() - captchaStartMs;
          logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          logger.info(`[getCaptcha] ✅ CAPTCHA HOÀN THÀNH! Bài mồi KHÔNG bị tạo.`);
          logger.info(`[getCaptcha] Token provider: ${tokenProvider ?? 'unknown'}`);
          logger.info(`[getCaptcha] Tổng thời gian: ${totalElapsed}ms (${Math.round(totalElapsed/1000)}s)`);
          logger.info(`[getCaptcha] Số round đã giải: ${challengeRound}`);
          logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          
          if (token) {
              this.setCaptchaToken(token); // Caching it for prewarm route logic!
          }

          resolve(token ?? null);
        } catch(err: any) {
          logger.error('[getCaptcha] ❌ Lỗi khi extract token từ intercepted request: ' + err.message);
          reject(err);
        }
      };
      logger.info('[getCaptcha] ✅ Generate intercept callback đã sẵn sàng.');
    });

    const timeoutPromise = new Promise<string|null>((resolve) => {
      timeoutId = setTimeout(() => {
        const elapsed = Date.now() - captchaStartMs;
        logger.warn(`[getCaptcha] ⏰ Timeout sau 3 phút (${elapsed}ms). Trả về null (graceful fallback).`);
        try {
          browserCtx.browser()?.close();
          controller.abort();
        } catch {}
        resolve(null);
      }, 180000);
    });

    return Promise.race([tokenPromise, timeoutPromise]);
  }

  /**
   * Imitates Cloudflare Turnstile loading error (unused, kept for reference).
   * Previously used to bypass Turnstile by reporting it as broken — no longer needed
   * since we now intercept the real Turnstile token from the generate/v2-web request.
   */
  private async getTurnstile() {
    return this.client.post(
      `https://clerk.suno.com/v1/client?__clerk_api_version=2021-02-05&_clerk_js_version=${SunoApi.CLERK_VERSION}&_method=PATCH`,
      { captcha_error: '300030,300030,300030' },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns
   */
  /**
   * Lưu token CAPTCHA đã giải (từ pre-warm) vào instance để generate() dùng lại.
   * Token chỉ có hiệu lực trong TOKEN_TTL_MS (4 phút).
   */
  public setCaptchaToken(token: string): void {
    this.cachedCaptchaToken = token;
    this.cachedCaptchaTokenAt = Date.now();
    logger.info(`[setCaptchaToken] ✅ Token pre-warm đã lưu (hết hạn sau ${SunoApi.TOKEN_TTL_MS / 1000}s)`);
  }

  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    vocal_gender?: string
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      false,
      undefined,
      undefined,
      make_instrumental,
      model,
      wait_audio,
      undefined,
      undefined,
      undefined,
      undefined,
      vocal_gender
    );
    const costTime = Date.now() - startTime;
    logger.info('Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    return response.data;
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    vocal_gender?: string
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags,
      undefined,
      undefined,
      undefined,
      vocal_gender
    );
    const costTime = Date.now() - startTime;
    logger.info(
      'Custom Generate Response:\n' + JSON.stringify(audios, null, 2)
    );
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param task Optional indication of what to do. Enter 'extend' if extending an audio, otherwise specify null.
   * @param continue_clip_id 
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number,
    vocal_gender?: string
  ): Promise<AudioInfo[]> {
    await this.keepAlive();
    // Generate browser-token (mimics Suno web client)
    const browserToken = Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64');
    const captchaToken = await this.getCaptcha();
    const payload: any = {
      mv: model || DEFAULT_MODEL,
      make_instrumental: make_instrumental,
      prompt: '',
      generation_type: 'TEXT',
      continue_at: continue_at,
      continue_clip_id: continue_clip_id,
      task: task,
      token: captchaToken,
      // Fields required by v2-web endpoint
      transaction_uuid: randomUUID(),
      override_fields: [],
      metadata: {
        web_client_pathname: '/create',
        is_max_mode: false,
        create_mode: isCustom ? 'custom' : 'simple',
        ...(vocal_gender ? { vocal_gender } : {})
      },
      artist_clip_id: null,
      artist_start_s: null,
      artist_end_s: null,
      cover_clip_id: null,
      cover_start_s: null,
      cover_end_s: null,
      continued_aligned_prompt: null,
      persona_id: null,
      token_provider: null,
      user_uploaded_images_b64: null
    };
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }
    logger.info(
      'generateSongs payload:\n' +
        JSON.stringify(
          {
            prompt: prompt,
            isCustom: isCustom,
            tags: tags,
            title: title,
            make_instrumental: make_instrumental,
            wait_audio: wait_audio,
            negative_tags: negative_tags,
            payload: payload
          },
          null,
          2
        )
    );
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2-web/`,
      payload,
      {
        timeout: 10000, // 10 seconds timeout
        headers: {
          'browser-token': JSON.stringify({ token: browserToken })
        }
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    const songIds = response.data.clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every((audio) => audio.status === 'error');
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      const allClips = response.data.clips;
      // Log ALL clips for debugging
      logger.info(`[generateSongs] Suno returned ${allClips.length} clips total:`);
      allClips.forEach((audio: any, i: number) => {
        logger.info(`  Clip[${i}]: id=${audio.id}, model_name=${audio.model_name}, title=${audio.title}, major_model_version=${audio.major_model_version}`);
      });

      // Filter: chỉ giữ clips có model_name = chirp-auk (standard)
      // Bỏ tất cả model khác (pro/preview/5.5 — chỉ 1 phút, không phải bài full)
      const standardModel = 'chirp-auk';
      const standardClips = allClips.filter((audio: any) => {
        const modelName = (audio.model_name || '');
        const isStandard = modelName === standardModel;
        if (isStandard) {
          logger.info(`  ✅ Keeping standard clip: id=${audio.id}, model_name=${modelName}`);
        } else {
          logger.info(`  ❌ Skipping non-standard clip: id=${audio.id}, model_name=${modelName}`);
        }
        return isStandard;
      });
      
      // Fallback: nếu không tìm thấy chirp-auk, lấy 2 clip đầu tiên
      const clipsToReturn = (standardClips.length > 0 ? standardClips : allClips).slice(0, 2);
      logger.info(`[generateSongs] ➡️  Returning ${clipsToReturn.length} clips (filtered from ${allClips.length}, standard model: ${standardModel})`);

      return clipsToReturn.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
  }

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   *
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean
  ): Promise<AudioInfo[]> {
    return this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt);
  }

  /**
   * Generate stems for a song.
   * @param song_id The ID of the song to generate stems for.
   * @returns A promise that resolves to an AudioInfo object representing the generated stems.
   */
  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
    );

    console.log('generateStems response:\n', response?.data);
    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }


  /**
   * Get the lyric alignment for a song.
   * @param song_id The ID of the song to get the lyric alignment for.
   * @returns A promise that resolves to an object containing the lyric alignment.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);

    console.log(`getLyricAlignment ~ response:`, response.data);
    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @param page An optional page number to retrieve audio information from.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    let url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    if (songIds) {
      url.searchParams.append('ids', songIds.join(','));
    }
    if (page) {
      url.searchParams.append('page', page);
    }
    logger.info('Get audio status: ' + url.href);
    const response = await this.client.get(url.href, {
      // 10 seconds timeout
      timeout: 10000
    });

    const audios = response.data.clips;

    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt
        ? this.parseLyrics(audio.metadata.prompt)
        : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message
    }));
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${clipId}`
    );
    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);
    
    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;
    
    logger.info(`Fetching persona data: ${url}`);
    
    const response = await this.client.get(url, {
      timeout: 10000 // 10 seconds timeout
    });

    if (response.status !== 200) {
      throw new Error('Error response: ' + response.statusText);
    }

    return response.data;
  }
}

export const sunoApi = async (cookie?: string) => {
  const resolvedCookie = cookie && cookie.includes('__client') ? cookie : process.env.SUNO_COOKIE; // Check for bad `Cookie` header (It's too expensive to actually parse the cookies *here*)
  if (!resolvedCookie) {
    logger.info('No cookie provided! Aborting...\nPlease provide a cookie either in the .env file or in the Cookie header of your request.')
    throw new Error('Please provide a cookie either in the .env file or in the Cookie header of your request.');
  }

  // Check if the instance for this cookie already exists in the cache
  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance)
    return cachedInstance;

  // If not, create a new instance and initialize it
  const instance = await new SunoApi(resolvedCookie).init();
  // Cache the initialized instance
  cache.set(resolvedCookie, instance);

  return instance;
};