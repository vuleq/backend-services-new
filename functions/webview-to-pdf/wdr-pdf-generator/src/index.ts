// src/index.ts - PDF Generator with API Gateway Proxy
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import puppeteer, { Browser, Page, HTTPRequest, ElementHandle } from 'puppeteer-core';

const defaultUserId = "00000000-0000-0000-0000-000000000000";
const defaultUserName = 'PaxOcean Admin';

// Type definitions
interface PdfRequest {
  url: string;
  filename?: string;
  userId?: string;
}

interface PdfGenerationResult {
  success: boolean;
  pdfBase64?: string;
  error?: string;
}

interface ContentCheckResult {
  contentLength: number;
  hasContent: boolean;
  title: string;
  hasAngular: boolean;
  url: string;
  loadedImages: number;
  totalImages: number;
  noLoadingSpinners: boolean; // Thêm property này
  contentReady?: boolean;
}

interface LoginResult {
  success: boolean;
  error?: string;
}

interface PdfResponse {
  filename: string;
  pdfBase64: string;
  size: number;
  generatedAt: string;
  url: string;
}

// Global variables
let browserInstance: Browser | null = null;
let chromiumModule: any = null;

// Login credentials
const LOGIN_CREDENTIALS = {
  username: 'tdthi@tma.com.vn',
  password: '12345678x@X'
};

function getLoginUserInfo(requestHeader: APIGatewayProxyEventHeaders | undefined) {
  let userId = defaultUserId;
  let userName = defaultUserName;

  if (requestHeader) {
    let token = requestHeader["Authorization"] || requestHeader["authorization"];
    if (token) {
      token = token.replace('Bearer ', '');
      const payload = parseJWT(token);
      console.log('JWT token processed successfully');
      userId = payload?.sub;
      userName = payload?.name;
    }
  }
  return { userId, userName };
}

function parseJWT(token: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (error) {
    console.error('JWT parse error occurred');
    return null;
  }
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('=== PDF GENERATOR STARTED ===');
  
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    // Parse request data
    const requestData = parseRequestData(event);
    console.log('Parsed request data:', requestData);

    // Get user info
    const userInfo = getUserInfo(event.headers, requestData.userId);
    console.log('User info:', userInfo);

    // Validate required fields
    if (!requestData.url) {
      const errorResponse = new ApiResponse(false, undefined, 'Missing required field: url');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate URL format
    if (!isValidUrl(requestData.url)) {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid URL format');
      return LambdaResponse.error(errorResponse, 400);
    }

    console.log('📄 Generating PDF for:', requestData.url);
    console.log('📁 Filename:', requestData.filename);
    console.log('👤 User:', userInfo.userName);
    
    const startTime = Date.now();

    // Generate PDF
    const pdfResult = await generatePdfWithLogin(requestData.url);
    
    const duration = Date.now() - startTime;
    console.log(`✅ PDF generated in ${duration}ms`);

    if (!pdfResult.success) {
      const errorResponse = new ApiResponse(false, undefined, pdfResult.error || 'PDF generation failed');
      return LambdaResponse.error(errorResponse, 500);
    }

    // Format response data
    const pdfSizeKB = Math.round(Buffer.from(pdfResult.pdfBase64!, 'base64').length / 1024);
    const responseData: PdfResponse = {
      filename: requestData.filename || 'report.pdf',
      pdfBase64: pdfResult.pdfBase64!,
      size: pdfSizeKB,
      generatedAt: new Date().toISOString(),
      url: requestData.url
    };

    console.log(`Successfully generated PDF: ${responseData.filename} (${pdfSizeKB}KB)`);

    const successResponse = new ApiResponse(
      true, 
      responseData, 
      `PDF generated successfully in ${duration}ms`
    );
    return LambdaResponse.success(successResponse, 200);

  } catch (error: any) {
    console.error('❌ Handler Error:', error);
    const errorResponse = new ApiResponse(
      false, 
      undefined, 
      `PDF generation failed: ${error.message}`
    );
    return LambdaResponse.error(errorResponse, 500);
  }
};

function parseRequestData(event: APIGatewayProxyEvent): PdfRequest {
  const queryParams = event.queryStringParameters || {};
  let body = {};
  
  if (event.body) {
    try {
      if (event.isBase64Encoded) {
        const decodedBody = Buffer.from(event.body, 'base64').toString('utf-8');
        body = JSON.parse(decodedBody);
      } else {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      }
    } catch (err) {
      console.warn('Failed to parse event.body:', err);
      body = {};
    }
  }
  
  const directData = (!event.queryStringParameters && !event.body) ? event : {};
  const sourceData: any = { ...queryParams, ...body, ...directData };

  return {
    url: sourceData.url,
    filename: sourceData.filename || 'report.pdf',
    userId: sourceData.userId || sourceData.user_id
  };
}

function getUserInfo(headers: APIGatewayProxyEventHeaders | undefined, inputUserId?: string): { userId: string; userName: string } {
  if (inputUserId) {
    const tokenInfo = getLoginUserInfo(headers);
    return { 
      userId: inputUserId, 
      userName: tokenInfo.userName || 'Direct User' 
    };
  }
  return getLoginUserInfo(headers);
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

async function initializeChromium(): Promise<void> {
  if (!chromiumModule) {
    const isLambda = !!process.env.LAMBDA_RUNTIME_DIR;
    
    try {
      if (isLambda) {
        try {
          console.log('📦 Loading @sparticuz/chromium...');
          chromiumModule = require('@sparticuz/chromium');
          chromiumModule.type = 'sparticuz';
          console.log('✅ @sparticuz/chromium loaded');
          return;
        } catch (sparticuzError) {
          console.log('⚠️ @sparticuz/chromium failed, trying chrome-aws-lambda...');
        }
        
        try {
          console.log('📦 Loading chrome-aws-lambda...');
          chromiumModule = require('chrome-aws-lambda');
          chromiumModule.type = 'chrome-aws-lambda';
          console.log('✅ chrome-aws-lambda loaded');
          return;
        } catch (chromeAwsLambdaError) {
          throw new Error('No chromium module available');
        }
      } else {
        console.log('🏠 Local environment - using @sparticuz/chromium');
        chromiumModule = require('@sparticuz/chromium');
        chromiumModule.type = 'sparticuz';
      }
    } catch (error: any) {
      console.error('❌ Chromium initialization failed:', error);
      throw new Error(`Chromium init failed: ${error.message}`);
    }
  }
}

async function getBrowserInstance(): Promise<Browser> {
  // Reuse browser in Lambda
  if (browserInstance && browserInstance.isConnected()) {
    console.log('♻️ Reusing browser');
    return browserInstance;
  }

  console.log('🚀 Launching browser...');
  const isLambda = !!process.env.LAMBDA_RUNTIME_DIR;

  if (isLambda) {
    await initializeChromium();
    
    let launchOptions: any;
    
    if (chromiumModule.type === 'sparticuz') {
      launchOptions = {
        args: [
          ...chromiumModule.args,
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--memory-pressure-off',
          '--max_old_space_size=4096'
        ],
        defaultViewport: { width: 1280, height: 1024 },
        executablePath: await chromiumModule.executablePath(),
        headless: true,
        ignoreHTTPSErrors: true,
        timeout: 60000
      };
    } else {
      launchOptions = {
        args: [
          ...chromiumModule.args,
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--memory-pressure-off'
        ],
        defaultViewport: { width: 1280, height: 1024 },
        executablePath: await chromiumModule.executablePath,
        headless: chromiumModule.headless,
        ignoreHTTPSErrors: true,
        timeout: 60000
      };
    }
    
    browserInstance = await puppeteer.launch(launchOptions);
    console.log(`✅ Browser launched with ${chromiumModule.type}`);
    
  } else {
    browserInstance = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ],
      defaultViewport: { width: 1280, height: 1024 },
      headless: true,
      ignoreHTTPSErrors: true,
      timeout: 60000
    });
    console.log('✅ Browser launched (local)');
  }
  
  return browserInstance!;
}

function extractDomainFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}`;
  } catch (error) {
    console.error('Error extracting domain:', error);
    return url;
  }
}

async function performLogin(page: Page, loginUrl: string): Promise<LoginResult> {
  try {
    console.log('🔐 Starting login at:', loginUrl);
    
    // Navigate to login page
    await page.goto(loginUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    console.log('✅ Login page loaded');
    
    // Check if already logged in
    try {
      await page.waitForSelector('input', { timeout: 15000 });
    } catch (error) {
      const currentUrl = page.url();
      if (!currentUrl.includes('/login')) {
        console.log('✅ Already logged in');
        return { success: true };
      }
      throw new Error('Login form not found');
    }

    // Wait for page stability
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Find and fill username
    console.log('🔍 Finding username field...');
    const usernameSelectors = [
      'input[formcontrolname="username"]',
      'input[type="email"]',
      'input[placeholder*="username" i]',
      'input[name*="username" i]'
    ];
    
    let usernameField: ElementHandle<Element> | null = null;
    for (const selector of usernameSelectors) {
      usernameField = await page.$(selector);
      if (usernameField) break;
    }
    
    if (!usernameField) {
      // Fallback: find first non-password input
      const allInputs = await page.$$('input');
      for (const input of allInputs) {
        const type = await page.evaluate(el => (el as HTMLInputElement).type, input);
        if (type !== 'password' && type !== 'hidden') {
          usernameField = input;
          break;
        }
      }
    }

    if (!usernameField) {
      throw new Error('Username field not found');
    }

    console.log('✏️ Filling username...');
    await usernameField.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await usernameField.type(LOGIN_CREDENTIALS.username, { delay: 50 });

    // Find and fill password
    console.log('🔍 Finding password field...');
    const passwordSelectors = [
      'input[formcontrolname="password"]',
      'input[type="password"]'
    ];
    
    let passwordField: ElementHandle<Element> | null = null;
    for (const selector of passwordSelectors) {
      passwordField = await page.$(selector);
      if (passwordField) break;
    }

    if (!passwordField) {
      throw new Error('Password field not found');
    }

    console.log('✏️ Filling password...');
    await passwordField.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await passwordField.type(LOGIN_CREDENTIALS.password, { delay: 50 });

    // Find and click login button
    console.log('🔍 Finding login button...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    const buttonSelectors = [
      'app-button',
      'button[type="submit"]',
      'input[type="submit"]'
    ];
    
    let loginButton: ElementHandle<Element> | null = null;
    for (const selector of buttonSelectors) {
      try {
        loginButton = await page.$(selector);
        if (loginButton) break;
      } catch (e) {
        continue;
      }
    }

    if (!loginButton) {
      throw new Error('Login button not found');
    }

    console.log('🖱️ Clicking login...');
    
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null),
        loginButton.click()
      ]);
    } catch (clickError) {
      console.log('Trying JS click...');
      await page.evaluate((element) => {
        (element as HTMLElement).click();
      }, loginButton);
      
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }

    // Verify login
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const currentUrl = page.url();
    console.log('🔍 Post-login URL:', currentUrl);

    if (currentUrl.includes('/login')) {
      throw new Error('Login failed - still on login page');
    }

    console.log('✅ Login successful');
    return { success: true };

  } catch (error: any) {
    console.error('❌ Login failed:', error);
    return { 
      success: false, 
      error: `Login failed: ${error.message}` 
    };
  }
}

async function generatePdfWithLogin(url: string): Promise<PdfGenerationResult> {
  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    console.log('🚀 Initializing browser...');
    browser = await getBrowserInstance();
    page = await browser.newPage();
    
    // Configure page
    await configurePageOptimized(page);
    
    // Determine login URL
    const domain = extractDomainFromUrl(url);
    const loginUrl = `${domain}/#/login`;
    
    console.log('🌐 Domain:', domain);
    console.log('🔐 Login URL:', loginUrl);
    
    // Perform login
    const loginResult = await performLogin(page, loginUrl);
    if (!loginResult.success) {
      throw new Error(loginResult.error || 'Login failed');
    }
    
    // Navigate to target URL
    console.log('🎯 Navigating to:', url);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });
    
    // Wait for content
    await waitForContentOptimized(page);
    
    // Optimize for PDF
    await optimizePageForPdf(page);
    
    // Generate PDF
    console.log('📄 Generating PDF...');
    const pdfBuffer = await page.pdf({
      format: 'a4',
      printBackground: true,
      preferCSSPageSize: false,
      width: '210mm',
      height: '297mm',
      margin: {
        top: '10mm',
        bottom: '10mm',
        left: '8mm',
        right: '8mm'
      },
      displayHeaderFooter: false,
      scale: 0.95,
      timeout: 60000,
      omitBackground: false
    });

    const pdfSizeKB = Math.round(pdfBuffer.length / 1024);
    console.log(`✅ PDF generated! Size: ${pdfSizeKB}KB`);

    return {
      success: true,
      pdfBase64: pdfBuffer.toString('base64')
    };

  } catch (error: any) {
    console.error('❌ PDF Generation Error:', error);
    return {
      success: false,
      error: error.message
    };
  } finally {
    if (page) {
      try {
        await page.close();
        console.log('✅ Page closed');
      } catch (err) {
        console.log('⚠️ Error closing page:', err);
      }
    }
    
    // Close browser only in local environment
    if (browser && !process.env.LAMBDA_RUNTIME_DIR) {
      try {
        await browser.close();
        browserInstance = null;
        console.log('✅ Browser closed (local)');
      } catch (err) {
        console.log('⚠️ Error closing browser:', err);
      }
    }
  }
}

async function configurePageOptimized(page: Page): Promise<void> {
  await page.setViewport({ 
    width: 1280, 
    height: 1024,
    deviceScaleFactor: 1
  });

  await page.setRequestInterception(true);
  
  page.on('request', (request: HTTPRequest) => {
    const resourceType = request.resourceType();
    const url = request.url();
    
    // Block unnecessary resources
    if (['media', 'other'].includes(resourceType) || 
        url.includes('analytics') || 
        url.includes('tracking') ||
        url.includes('ads')) {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
  });

  // Add CSS to prevent layout issues
  await page.addStyleTag({
    content: `
      * {
        -webkit-print-color-adjust: exact !important;
        color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      body {
        margin: 0 !important;
        padding: 0 !important;
        overflow-x: hidden !important;
        max-width: 100% !important;
      }
      .container, .main-content, .content {
        max-width: 100% !important;
        width: 100% !important;
        overflow: visible !important;
      }
    `
  });
}

async function waitForContentOptimized(page: Page): Promise<void> {
  console.log('⏳ Waiting for content to load...');
  
  // 1. Check for SPA framework and network idle in parallel
  const [spaDetected] = await Promise.allSettled([
    Promise.race([
      page.waitForSelector('app-root', { timeout: 8000 }),
      page.waitForSelector('[ng-version]', { timeout: 8000 }),
      page.waitForSelector('.ng-star-inserted', { timeout: 8000 }),
      page.waitForFunction(() => {
        return window.location.href.includes('app') ||
                window.location.href.includes('mobile') ||
               document.readyState === 'complete';
      }, { timeout: 8000 })
    ]),
        
    // Network idle detection
    new Promise(async (resolve) => {
      try {
        await page.waitForFunction(
          () => {
            return (performance.getEntriesByType('navigation')[0] as any)?.loadEventEnd > 0 &&
                   document.readyState === 'complete';
          }, 
          { timeout: 5000 }
        );
        resolve(true);
      } catch {
        resolve(false);
      }
    })
  ]);

  if (spaDetected.status === 'fulfilled') {
    console.log('✅ SPA framework detected');
  }

  // 2. Smart content polling với thời gian chờ tăng
  const startTime = Date.now();
  let contentReady = false;
  const pollInterval = 500;
  const maxWaitTime = 12000; // Tăng từ 8s lên 12s
    
  while (!contentReady && (Date.now() - startTime) < maxWaitTime) {
    const contentCheck: ContentCheckResult = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const allImages = document.querySelectorAll('img');
      const visibleImages = Array.from(allImages).filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
            
      let loadedImages = 0;
      visibleImages.forEach(img => {
        if ((img as HTMLImageElement).complete && (img as HTMLImageElement).naturalHeight !== 0) {
          loadedImages++;
        }
      });

      // Kiểm tra strict hơn
      const hasGoodContent = bodyText.length > 800; // Tăng từ 500 lên 800
      const imagesLoaded = visibleImages.length === 0 || (loadedImages / visibleImages.length) >= 0.9; // Tăng từ 0.8 lên 0.9
      const pageStable = document.readyState === 'complete';
      
      // Kiểm tra thêm các loading indicators
      const noLoadingSpinners = !document.querySelector('.loading, .spinner, [class*="load"], .skeleton');
      
      return {
        contentLength: bodyText.length,
        hasContent: hasGoodContent,
        title: document.title || '',
        hasAngular: !!(document.querySelector('[ng-version]') || (window as any).ng),
        url: window.location.href,
        loadedImages,
        totalImages: visibleImages.length,
        noLoadingSpinners,
        contentReady: hasGoodContent && imagesLoaded && pageStable && noLoadingSpinners
      };
    });

    console.log('📊 Content check:', {
      contentLength: contentCheck.contentLength,
      images: `${contentCheck.loadedImages}/${contentCheck.totalImages}`,
      noSpinners: contentCheck.noLoadingSpinners,
      elapsed: `${Date.now() - startTime}ms`
    });

    if (contentCheck.contentReady) {
      contentReady = true;
      console.log('✅ Content ready!');
      break;
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  // 3. Fallback if content not ready
  if (!contentReady) {
    console.log('⚠️ Applying fallback strategies...');
        
    // Scroll to trigger lazy loading
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
      return new Promise(resolve => setTimeout(resolve, 500));
    }).then(() => 
      page.evaluate(() => window.scrollTo(0, 0))
    );

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 4. Final stabilization - Tăng thời gian chờ cuối
  console.log('⏳ Final stabilization...');
  await new Promise(resolve => setTimeout(resolve, 3000)); // Tăng từ 1s lên 3s
    
  console.log('✅ Content loading completed');
}

async function optimizePageForPdf(page: Page): Promise<void> {
  console.log('🎨 Optimizing for PDF...');

  await page.evaluate(() => {
    // Remove fixed/sticky elements
    const fixedElements = document.querySelectorAll('[style*="position: fixed"], [style*="position: sticky"]');
    fixedElements.forEach(el => {
      (el as HTMLElement).style.position = 'static';
    });

    // Remove lazy loading
    const lazyElements = document.querySelectorAll('[loading="lazy"]');
    lazyElements.forEach(el => {
      el.removeAttribute('loading');
    });

    // Force load images with data-src
    const images = document.querySelectorAll('img[data-src]');
    images.forEach(img => {
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc) {
        img.setAttribute('src', dataSrc);
      }
    });

    return true;
  });

  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('✅ Page optimized');
}