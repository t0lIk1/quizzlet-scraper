require('dotenv').config();
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const { downloadAllMedia } = require('./utils');
const { exportFlashcards } = require('./exporter');

// Configuration from environment
const CONFIG = {
  classUrl: process.env.QUIZLET_CLASS_URL || '',
  email: process.env.QUIZLET_EMAIL || '',
  password: process.env.QUIZLET_PASSWORD || '',
  outputFormat: process.env.OUTPUT_FORMAT || 'both',
  outputFilename: process.env.OUTPUT_FILENAME || 'quizlet-export',
  headless: process.env.HEADLESS !== 'false',
  requestDelay: parseInt(process.env.REQUEST_DELAY) || 1000,
  outputFolder: path.resolve(__dirname, '..', 'output'),
  mediaFolder: path.resolve(__dirname, '..', 'media'),
  interactive: process.env.INTERACTIVE === 'true'
};

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Interactive mode - browser stays open until user presses Ctrl+C
 * With optional auto-login and auto-scrape
 * @returns {Promise<Object>} - Storage state and class URL
 */
async function interactiveMode() {
  console.log('-'.repeat(60));
  console.log('INTERACTIVE MODE: Manual control');
  console.log('-'.repeat(60));
  console.log('A browser window will open and STAY OPEN.');
  console.log();
  
  const hasCredentials = CONFIG.email && CONFIG.password;
  
  if (hasCredentials) {
    console.log('Auto-login enabled with credentials from .env');
  } else {
    console.log('No credentials in .env - manual login required.');
  }
  
  console.log();
  console.log('What to do:');
  console.log('1. Log in to Quizlet (automatic if credentials provided)');
  console.log('2. Script will navigate to class page automatically');
  console.log('3. Script will scrape all sets automatically');
  console.log('4. Press Ctrl+C when done to save session');
  console.log();
  console.log('The session will be saved to .storage-state.json');
  console.log('Next run: set INTERACTIVE=false to use saved session');
  console.log('-'.repeat(60));
  console.log();

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--start-maximized'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  
  // Open Quizlet login page
  await page.goto('https://quizlet.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  // Auto-login if credentials provided
  if (hasCredentials) {
    console.log('Entering credentials...');
    
    try {
      // Find and fill email/username field
      const emailInput = await page.$('input[type="email"], input[name="email"], input[name="username"], input[id="username"], input[placeholder*="email"], input[placeholder*="Email"], input[placeholder*="почта"], input[aria-label*="email"], input[aria-label*="почта"]');
      if (emailInput) {
        await emailInput.fill(CONFIG.email);
        console.log('Email entered');
      } else {
        console.log('Email field not found, trying alternative selectors...');
        const inputs = await page.$$('input[type="text"], input:not([type])');
        for (const input of inputs) {
          const placeholder = await input.getAttribute('placeholder');
          const ariaLabel = await input.getAttribute('aria-label');
          const name = await input.getAttribute('name');
          const id = await input.getAttribute('id');
          if ((placeholder && (placeholder.toLowerCase().includes('email') || placeholder.toLowerCase().includes('почта') || placeholder.toLowerCase().includes('имя'))) ||
              (ariaLabel && (ariaLabel.toLowerCase().includes('email') || ariaLabel.toLowerCase().includes('почта'))) ||
              (name && (name.includes('email') || name.includes('username'))) ||
              (id && (id.includes('email') || id.includes('username')))) {
            await input.fill(CONFIG.email);
            console.log('Email entered (alternative selector)');
            break;
          }
        }
      }
      
      // Find and fill password field
      const passwordInput = await page.$('input[type="password"], input[name="password"], input[id="password"]');
      if (passwordInput) {
        await passwordInput.fill(CONFIG.password);
        console.log('Password entered');
      } else {
        console.log('Password field not found');
      }
      
      // Find and click submit button
      await page.waitForTimeout(1000);
      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button[class*="submit"], button[class*="login"], button[data-testid*="submit"], button[id*="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        console.log('Login submitted');
      } else {
        console.log('Submit button not found - trying to press Enter');
        if (passwordInput) {
          await passwordInput.press('Enter');
          console.log('Enter key pressed');
        }
      }
      
      // Wait for navigation after login
      await page.waitForTimeout(3000);
      
    } catch (error) {
      console.log('Auto-login failed:', error.message);
      console.log('Please login manually');
    }
  }
  
  // Navigate to class URL if provided
  if (CONFIG.classUrl) {
    console.log();
    console.log(`Class URL from .env: ${CONFIG.classUrl}`);
    console.log('Navigating to class page...');
    await page.goto(CONFIG.classUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('Class page loaded!');
  } else {
    console.log();
    console.log('No QUIZLET_CLASS_URL in .env - navigate manually.');
    console.log('Press Ctrl+C when ready to save session and exit.');
    console.log();
    
    // Wait for user to navigate manually
    await new Promise(() => {});
    return;
  }
  
  console.log();
  console.log('📌 Scrolling through sets to load them...');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  
  // Extract all set URLs
  console.log('Extracting set URLs from class page...');
  const setUrls = await page.evaluate(() => {
    const urls = new Set();
    const links = document.querySelectorAll('a[href*="/"]');
    
    links.forEach(link => {
      const href = link.href;
      if (href.includes('/quizlet.com/') && 
          !href.includes('/class/') &&
          !href.includes('/study/') &&
          !href.includes('/learn/') &&
          !href.includes('/test/') &&
          !href.includes('/match/') &&
          !href.includes('/gravity/') &&
          !href.includes('/_/') &&
          !href.includes('#')) {
        const cleanUrl = href.split('?')[0].split('#')[0];
        if (/\/quizlet\.com\/\d+\//.test(cleanUrl)) {
          urls.add(cleanUrl);
        }
      }
    });

    // Check for set cards with data attributes
    const setCards = document.querySelectorAll('[data-setid]');
    setCards.forEach(card => {
      const setId = card.getAttribute('data-setid');
      if (setId) {
        urls.add(`https://quizlet.com/${setId}`);
      }
    });

    return Array.from(urls);
  });
  
  console.log(`Found ${setUrls.length} sets`);
  console.log();
  
  if (setUrls.length === 0) {
    console.log('No sets found. You may need to scroll more or navigate manually.');
    console.log('Press Ctrl+C when ready to save session and exit.');
    await new Promise(() => {});
    return;
  }
  
  // Scrape each set
  const allCards = [];
  
  for (let i = 0; i < setUrls.length; i++) {
    const setUrl = setUrls[i];
    console.log(`[${i + 1}/${setUrls.length}] Scraping: ${setUrl}`);
    
    try {
      await page.goto(setUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      
      // Scroll to load all cards
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      
      const cards = await page.evaluate(() => {
        const cards = [];
        const termElements = document.querySelectorAll('[data-term]');
        
        if (termElements.length > 0) {
          termElements.forEach((term) => {
            try {
              const front = term.querySelector('[data-side="front"]')?.textContent?.trim() || 
                           term.querySelector('.TermText:not(.hidden)')?.textContent?.trim() ||
                           term.textContent?.trim() || '';
              
              const back = term.querySelector('[data-side="back"]')?.textContent?.trim() ||
                          term.querySelectorAll('.TermText:not(.hidden)')?.[1]?.textContent?.trim() ||
                          '';

              const img = term.querySelector('img[src*="quizlet.com"]');
              const imageUrl = img ? img.src : null;

              const audioBtn = term.querySelector('[data-role="audio"], .audio-button');
              let audioUrl = null;
              if (audioBtn) {
                audioUrl = audioBtn.getAttribute('data-audio-url') || 
                          audioBtn.getAttribute('data-src');
              }

              if (front && back) {
                cards.push({
                  front: front.replace(/\n/g, ' ').replace(/\s+/g, ' '),
                  back: back.replace(/\n/g, ' ').replace(/\s+/g, ' '),
                  imageUrl,
                  audioUrl
                });
              }
            } catch (e) {}
          });
        }
        
        // Alternative: look for .TermText elements
        if (cards.length === 0) {
          const allTerms = document.querySelectorAll('.TermText');
          for (let j = 0; j < allTerms.length; j += 2) {
            const front = allTerms[j]?.textContent?.trim() || '';
            const back = allTerms[j + 1]?.textContent?.trim() || '';
            if (front && back) {
              cards.push({
                front: front.replace(/\n/g, ' ').replace(/\s+/g, ' '),
                back: back.replace(/\n/g, ' ').replace(/\s+/g, ' '),
                imageUrl: null,
                audioUrl: null
              });
            }
          }
        }
        
        return cards;
      });
      
      const setTitle = await page.title();
      console.log(`  ✓ Extracted ${cards.length} cards from "${setTitle.substring(0, 50)}"`);
      allCards.push(...cards);
      
      // Delay between sets
      await page.waitForTimeout(1000);
      
    } catch (error) {
      console.log(`  ✗ Failed: ${error.message}`);
    }
  }
  
  console.log();
  console.log(`Total cards collected: ${allCards.length}`);
  console.log();
  
  // Save cards to JSON for later export
  if (allCards.length > 0) {
    const cardsPath = path.resolve(__dirname, '..', 'output', 'cards.json');
    require('fs').writeFileSync(cardsPath, JSON.stringify(allCards, null, 2));
    console.log(`Cards saved to: ${cardsPath}`);
    console.log();
  }
  
  console.log('-'.repeat(60));
  console.log('Scraping complete!');
  console.log('Press Ctrl+C to save session and exit.');
  console.log('Then set INTERACTIVE=false and run again to export.');
  console.log('-'.repeat(60));
  console.log();

  // Save session on Ctrl+C
  process.on('SIGINT', async () => {
    console.log();
    console.log('Saving session...');
    
    const storageState = path.resolve(__dirname, '..', '.storage-state.json');
    await context.storageState({ path: storageState });
    console.log(`Session saved to: ${storageState}`);
    
    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);
    
    await browser.close();
    console.log('Browser closed. Exit.');
    process.exit(0);
  });

  // Keep running until Ctrl+C
  await new Promise(() => {});
}

/**
 * Create browser context with anti-detection
 * @param {boolean} headless 
 * @param {string} storageState 
 * @returns {Promise<Object>}
 */
async function createBrowserContext(headless = true, storageState = null) {
  const browserArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-setuid-sandbox'
  ];

  if (!headless) {
    browserArgs.push('--start-maximized');
  }

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    }
  };

  if (storageState) {
    contextOptions.storageState = storageState;
  }

  const browser = await chromium.launch({
    headless,
    args: browserArgs
  });

  const context = await browser.newContext(contextOptions);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  return { browser, context };
}

/**
 * Main export function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('  Quizlet to Anki Exporter');
  console.log('='.repeat(60));
  console.log();

  // Validate configuration
  if (!CONFIG.classUrl) {
    console.error('ERROR: QUIZLET_CLASS_URL is not set in .env file');
    console.error('Please add your Quizlet class URL to the .env file');
    console.error('Example: QUIZLET_CLASS_URL=https://quizlet.com/class/123456789');
    process.exit(1);
  }

  console.log('Configuration:');
  console.log(`  Class URL: ${CONFIG.classUrl}`);
  console.log(`  Output Format: ${CONFIG.outputFormat}`);
  console.log(`  Output Filename: ${CONFIG.outputFilename}`);
  console.log(`  Headless Mode: ${CONFIG.headless}`);
  console.log(`  Request Delay: ${CONFIG.requestDelay}ms`);
  console.log(`  Interactive Mode: ${CONFIG.interactive}`);
  console.log();

  let storageState = null;
  let classUrl = CONFIG.classUrl;

  // Interactive mode - browser stays open for manual control
  if (CONFIG.interactive) {
    await interactiveMode();
    return; // Exit after interactive session
  }

  // Check if we have saved storage state
  const storageStatePath = path.resolve(__dirname, '..', '.storage-state.json');
  if (require('fs').existsSync(storageStatePath)) {
    storageState = storageStatePath;
    console.log('Using saved session from:', storageStatePath);
    console.log();
  }

  try {
    // Check if we have saved cards from interactive mode
    const cardsPath = path.resolve(__dirname, '..', 'output', 'cards.json');
    let allCards = [];
    
    if (require('fs').existsSync(cardsPath)) {
      console.log('Found saved cards from previous session.');
      console.log(`Loading from: ${cardsPath}`);
      allCards = JSON.parse(require('fs').readFileSync(cardsPath, 'utf8'));
      console.log(`Loaded ${allCards.length} cards`);
      console.log();
    } else {
      console.log('No saved cards found. Run with INTERACTIVE=true first.');
      console.log('Or set INTERACTIVE=true to scrape now.');
      process.exit(0);
    }
    
    if (allCards.length === 0) {
      console.warn('No cards to export.');
      process.exit(0);
    }

    // Step 1: Download media files
    console.log('-'.repeat(60));
    console.log('Step 1: Downloading images and audio...');
    console.log('-'.repeat(60));
    
    const cardsWithMedia = await downloadAllMedia(
      allCards, 
      CONFIG.mediaFolder, 
      CONFIG.requestDelay / 2
    );
    
    const cardsWithImages = cardsWithMedia.filter(c => c.localImagePath).length;
    const cardsWithAudio = cardsWithMedia.filter(c => c.localAudioPath).length;
    console.log(`Cards with images: ${cardsWithImages}`);
    console.log(`Cards with audio: ${cardsWithAudio}`);
    console.log();

    // Step 2: Export to Anki format
    console.log('-'.repeat(60));
    console.log('Step 2: Exporting to Anki format...');
    console.log('-'.repeat(60));
    
    const exportResults = await exportFlashcards(cardsWithMedia, {
      outputFolder: CONFIG.outputFolder,
      filename: CONFIG.outputFilename,
      format: CONFIG.outputFormat,
      setTitle: 'Quizlet Export',
      mediaFolder: CONFIG.mediaFolder
    });

    console.log();
    console.log('='.repeat(60));
    console.log('  Export Complete!');
    console.log('='.repeat(60));
    console.log();
    console.log('Output files:');
    if (exportResults.csv) {
      console.log(`  CSV: ${path.resolve(exportResults.csv)}`);
    }
    if (exportResults.apkg) {
      console.log(`  APKG: ${path.resolve(exportResults.apkg)}`);
    }
    console.log();
    console.log('Media folder:');
    console.log(`  ${path.resolve(CONFIG.mediaFolder)}`);
    console.log();
    console.log('To import into Anki:');
    console.log('  1. Open Anki');
    console.log('  2. Click File > Import');
    console.log('  3. Select the .apkg file (recommended)');
    console.log();

  } catch (error) {
    console.error();
    console.error('='.repeat(60));
    console.error('  ERROR: Export failed!');
    console.error('='.repeat(60));
    console.error(error.message);
    console.error();
    console.error('Stack trace:');
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the exporter
main();
