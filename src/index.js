require('dotenv').config();
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const notifier = require('node-notifier');
const fs = require('fs');
const { downloadAllMedia } = require('./utils');
const { exportFlashcards } = require('./exporter');

// Track failed and empty sets
const failedSets = [];
const emptySets = [];
let allCards = [];
let setsData = [];

// URL tracking for resume functionality
let urlProgress = {
  classUrl: '',
  scrapedAt: null,
  urls: [] // [{ url, status: 'pending'|'completed'|'failed', error?: string, cards?: number }]
};

/**
 * Load or create URL progress file
 */
function loadUrlProgress(progressPath) {
  if (fs.existsSync(progressPath)) {
    try {
      urlProgress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      console.log(`📋 Loaded progress from: ${progressPath}`);
      console.log(`   Total URLs: ${urlProgress.urls.length}`);
      console.log(`   Completed: ${urlProgress.urls.filter(u => u.status === 'completed').length}`);
      console.log(`   Failed: ${urlProgress.urls.filter(u => u.status === 'failed').length}`);
      console.log(`   Pending: ${urlProgress.urls.filter(u => u.status === 'pending').length}`);
      return true;
    } catch (err) {
      console.log(`⚠️  Could not load progress file, starting fresh`);
    }
  }
  return false;
}

/**
 * Save URL progress
 */
function saveUrlProgress(progressPath) {
  urlProgress.scrapedAt = new Date().toISOString();
  fs.writeFileSync(progressPath, JSON.stringify(urlProgress, null, 2), 'utf8');
}

/**
 * Save failed sets log
 */
function saveFailedSetsLog() {
  const logPath = path.resolve(__dirname, '..', 'failed-sets.log');
  let logContent = 'Failed and Empty Sets Log\n';
  logContent += `Generated: ${new Date().toISOString()}\n`;
  logContent += '='.repeat(60) + '\n\n';

  if (failedSets.length > 0) {
    logContent += '❌ FAILED SETS (scraping error):\n';
    logContent += '-'.repeat(60) + '\n';
    failedSets.forEach((set, i) => {
      logContent += `${i + 1}. ${set.name}\n`;
      logContent += `   URL: ${set.url}\n`;
      logContent += `   Error: ${set.error}\n\n`;
    });
  }

  if (emptySets.length > 0) {
    logContent += '⚠️  EMPTY SETS (0 cards found):\n';
    logContent += '-'.repeat(60) + '\n';
    emptySets.forEach((set, i) => {
      logContent += `${i + 1}. ${set.name}\n`;
      logContent += `   URL: ${set.url}\n\n`;
    });
  }

  if (failedSets.length === 0 && emptySets.length === 0) {
    logContent += '✅ All sets scraped successfully!\n';
  }

  logContent += '\n' + '='.repeat(60) + '\n';
  logContent += `Total Failed: ${failedSets.length}\n`;
  logContent += `Total Empty: ${emptySets.length}\n`;

  fs.writeFileSync(logPath, logContent, 'utf8');
  console.log(`Failed sets log saved to: ${logPath}`);
}

/**
 * Save cards to JSON file (incremental save)
 */
function saveCardsIncremental() {
  // Use absolute path from project root
  const projectRoot = path.resolve(__dirname, '..');
  const outputFolder = path.join(projectRoot, 'output');
  const cardsPath = path.join(outputFolder, 'cards.json');
  
  // Don't save if no data
  if (setsData.length === 0 && allCards.length === 0) {
    console.log(`  ⚠️  No data to save (sets: ${setsData.length}, cards: ${allCards.length})`);
    return;
  }
  
  // Ensure output folder exists
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
    console.log(`  📁 Created output folder: ${outputFolder}`);
  }
  
  try {
    const outputData = {
      exportedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      classUrl: CONFIG.classUrl,
      totalSets: setsData.length,
      totalCards: allCards.length,
      sets: setsData
    };
    fs.writeFileSync(cardsPath, JSON.stringify(outputData, null, 2), 'utf8');
    console.log(`  💾 Saved: ${cardsPath}`);
    console.log(`     Sets: ${setsData.length}, Cards: ${allCards.length}`);
  } catch (err) {
    console.error(`  ❌ Failed to save cards.json: ${err.message}`);
    console.error(`     Path: ${cardsPath}`);
    sendNotification('Save Failed', err.message, 'error');
  }
}

/**
 * Send desktop notification
 * @param {string} title - Notification title
 * @param {string} message - Notification message
 * @param {string} urgency - 'info', 'warning', or 'error'
 */
function sendNotification(title, message, urgency = 'info') {
  const icon = urgency === 'error' ? '❌' : urgency === 'warning' ? '⚠️' : '✅';
  
  notifier.notify({
    title: `${icon} ${title}`,
    message: message,
    sound: urgency === 'error' ? true : false,
    wait: false
  }, (err) => {
    if (err) {
      console.log(`[Notification] ${title}: ${message}`);
    }
  });
}

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

// Parse command line arguments
const ARGS = {
  resume: process.argv.includes('--resume') || process.argv.includes('-r'),
  fresh: process.argv.includes('--fresh') || process.argv.includes('-f'),
  help: process.argv.includes('--help') || process.argv.includes('-h')
};

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
Quizlet Scraper - Usage
========================

npm start [options]

Options:
  --resume, -r     Resume from failed/pending URLs (default behavior if url-progress.json exists)
  --fresh, -f      Start fresh, ignore existing progress file
  --help, -h       Show this help message

Examples:
  npm start                    # Run with default settings
  npm start -- --fresh         # Start fresh, ignore previous progress
  npm start -- --resume        # Resume from where you left off
  npm start -- --help          # Show help

Environment Variables (.env):
  QUIZLET_CLASS_URL       - Your Quizlet class URL
  QUIZLET_EMAIL           - Quizlet account email
  QUIZLET_PASSWORD        - Quizlet account password
  INTERACTIVE             - Set to 'true' for interactive mode
  REQUEST_DELAY           - Delay between requests in ms (default: 5000)
`);
}

/**
 * Interactive mode - browser stays open until user presses Ctrl+C
 * With optional auto-login and auto-scrape
 * @returns {Promise<Object>} - Storage state and class URL
 */
async function interactiveMode() {
  // Show help if requested
  if (ARGS.help) {
    showHelp();
    process.exit(0);
  }

  console.log('-'.repeat(60));
  console.log('INTERACTIVE MODE: Manual control');
  console.log('-'.repeat(60));
  console.log('A browser window will open and STAY OPEN.');
  console.log();

  // Show resume/fresh status
  let progressPath = path.resolve(__dirname, '..', 'url-progress.json');
  const hasProgress = fs.existsSync(progressPath);

  if (ARGS.fresh && hasProgress) {
    console.log('🗑️  Fresh start requested - removing old progress file...');
    fs.unlinkSync(progressPath);
    console.log('   Deleted: ' + progressPath);
    console.log();
  } else if (ARGS.resume && hasProgress) {
    console.log('▶️  Resume mode - continuing from failed/pending URLs');
    console.log();
  }

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

  // Check for Cloudflare page
  async function checkCloudflare() {
    const url = page.url();
    const title = await page.title();
    const isCloudflare = title.includes('Cloudflare') || 
                         title.includes('Just a moment') ||
                         title.includes('Один момент') ||
                         url.includes('challenges.cloudflare.com');
    
    if (isCloudflare) {
      console.log();
      console.log('⚠️  CLOUDFLARE DETECTED!');
      console.log('----------------------------------------');
      console.log('Please complete the Cloudflare challenge manually.');
      console.log('The script will wait for you...');
      console.log('----------------------------------------');
      
      sendNotification('Cloudflare Challenge', 'Please complete the verification in the browser', 'warning');
      
      // Wait for Cloudflare to be bypassed (check every 2 seconds)
      let waited = 0;
      while (waited < 300000) { // 5 minute timeout
        await page.waitForTimeout(2000);
        waited += 2000;
        
        const currentTitle = await page.title();
        const currentUrl = page.url();
        const stillCloudflare = currentTitle.includes('Cloudflare') || 
                               currentTitle.includes('Just a moment') ||
                               currentTitle.includes('Один момент') ||
                               currentUrl.includes('challenges.cloudflare.com');
        
        if (!stillCloudflare) {
          console.log('✓ Cloudflare bypassed! Continuing...');
          sendNotification('Cloudflare Passed', 'Continuing with scraping', 'info');
          await page.waitForTimeout(2000); // Wait for page to fully load
          return true;
        }
      }
      
      console.log('✗ Cloudflare timeout after 5 minutes');
      sendNotification('Cloudflare Timeout', 'Script timed out waiting for verification', 'error');
      return false;
    }
    return true;
  }

  // Check for Cloudflare on current page
  await checkCloudflare();

  // Progress file path (reassign)
  progressPath = path.resolve(__dirname, '..', 'url-progress.json');

  // Try to load existing progress
  const loadedProgress = loadUrlProgress(progressPath);
  let pageUrls = [];

  // If fresh start or no progress, extract URLs from page
  if (ARGS.fresh || !loadedProgress || urlProgress.classUrl !== CONFIG.classUrl) {
    console.log('Extracting set URLs from class page...');
    pageUrls = await page.evaluate(() => {
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

    console.log(`Found ${pageUrls.length} sets on page`);

    // Initialize or reset urlProgress
    console.log('📋 Creating new progress file...');
    urlProgress = {
      classUrl: CONFIG.classUrl,
      scrapedAt: null,
      urls: pageUrls.map(url => ({ url, status: 'pending', error: null, cards: 0 }))
    };
  } else {
    // Using existing progress - check for new URLs
    console.log('Using existing progress file');
    
    // Extract URLs from page to check for new ones
    pageUrls = await page.evaluate(() => {
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

      const setCards = document.querySelectorAll('[data-setid]');
      setCards.forEach(card => {
        const setId = card.getAttribute('data-setid');
        if (setId) {
          urls.add(`https://quizlet.com/${setId}`);
        }
      });

      return Array.from(urls);
    });

    // Add new URLs
    const existingUrls = new Set(urlProgress.urls.map(u => u.url));
    let newCount = 0;
    pageUrls.forEach(url => {
      if (!existingUrls.has(url)) {
        urlProgress.urls.push({ url, status: 'pending', error: null, cards: 0 });
        newCount++;
      }
    });
    if (newCount > 0) {
      console.log(`➕ Added ${newCount} new URLs to progress`);
      saveUrlProgress(progressPath);
    }
  }

  // Filter to only pending and failed URLs for scraping
  const urlsToScrape = urlProgress.urls.filter(u => u.status === 'pending' || u.status === 'failed');
  console.log(`URLs to scrape: ${urlsToScrape.length}`);
  console.log();

  if (urlsToScrape.length === 0) {
    console.log('✅ All URLs already completed!');
    console.log();
    console.log('To scrape again, use:');
    console.log('  npm start -- --fresh    # Reset all progress');
    console.log('  npm start -- --resume   # Retry failed only');
    console.log();
    saveUrlProgress(progressPath);
  }

  // Scrape each set (use global allCards and setsData)
  for (let i = 0; i < urlsToScrape.length; i++) {
    const setUrl = urlsToScrape[i].url;
    const urlIndex = urlProgress.urls.findIndex(u => u.url === setUrl);
    console.log(`[${i + 1}/${urlsToScrape.length}] Scraping: ${setUrl}`);

    try {
      await page.goto(setUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check for Cloudflare
      const cfPassed = await checkCloudflare();
      if (!cfPassed) {
        console.log(`  ⚠ Skipping due to Cloudflare`);
        if (urlIndex >= 0) {
          urlProgress.urls[urlIndex].status = 'failed';
          urlProgress.urls[urlIndex].error = 'Cloudflare timeout';
          saveUrlProgress(progressPath);
        }
        await page.waitForTimeout(5000);
        continue;
      }

      // Scroll to load all cards
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      // Check for access denied or rate limit
      const pageTitle = await page.title();
      const isAccessDenied = pageTitle.includes('Access') && pageTitle.includes('denied');
      const isRateLimited = pageTitle.includes('429') || pageTitle.includes('Rate Limit');

      if (isAccessDenied || isRateLimited) {
        console.log(`  ⚠ ${isRateLimited ? 'Rate limited!' : 'Access denied'} - "${pageTitle}"`);
        sendNotification(isRateLimited ? 'Rate Limited!' : 'Access Denied',
                        `Waiting 30 seconds...`, 'warning');

        // Track failed set and update progress
        failedSets.push({
          name: pageTitle,
          url: setUrl,
          error: isRateLimited ? 'Rate Limit (429)' : 'Access Denied'
        });

        if (urlIndex >= 0) {
          urlProgress.urls[urlIndex].status = 'failed';
          urlProgress.urls[urlIndex].error = isRateLimited ? 'Rate Limit (429)' : 'Access Denied';
          saveUrlProgress(progressPath);
        }

        await page.waitForTimeout(30000); // Wait 30 seconds on rate limit
        continue;
      }

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

      if (cards.length > 0) {
        console.log(`  ✓ Extracted ${cards.length} cards from "${setTitle.substring(0, 50)}"`);
        // Add set info to each card
        const cardsWithSet = cards.map(card => ({
          ...card,
          setName: setTitle,
          setUrl: setUrl
        }));
        allCards.push(...cardsWithSet);
        setsData.push({
          setName: setTitle,
          setUrl: setUrl,
          cards: cardsWithSet
        });

        // Update progress
        if (urlIndex >= 0) {
          urlProgress.urls[urlIndex].status = 'completed';
          urlProgress.urls[urlIndex].cards = cards.length;
          urlProgress.urls[urlIndex].error = null;
          saveUrlProgress(progressPath);
        }

        // Save immediately after successful scrape
        saveCardsIncremental();
      } else {
        console.log(`  ⚠ No cards found in "${setTitle.substring(0, 50)}"`);
        sendNotification('No Cards Found', `"${setTitle.substring(0, 30)}"`, 'warning');

        // Track empty set
        emptySets.push({
          name: setTitle,
          url: setUrl
        });

        // Update progress - mark as completed even if empty
        if (urlIndex >= 0) {
          urlProgress.urls[urlIndex].status = 'completed';
          urlProgress.urls[urlIndex].cards = 0;
          saveUrlProgress(progressPath);
        }
      }

      // Delay between sets
      await page.waitForTimeout(1500);

    } catch (error) {
      console.log(`  ✗ Failed: ${error.message}`);
      sendNotification('Scraping Failed', `Set ${i + 1}/${urlsToScrape.length}: ${error.message}`, 'error');

      // Track failed set and update progress
      failedSets.push({
        name: setTitle || `Set ${i + 1}`,
        url: setUrl,
        error: error.message
      });

      if (urlIndex >= 0) {
        urlProgress.urls[urlIndex].status = 'failed';
        urlProgress.urls[urlIndex].error = error.message;
        saveUrlProgress(progressPath);
      }

      await page.waitForTimeout(3000);
    }
  }

  console.log();
  console.log(`Total cards collected: ${allCards.length}`);
  console.log();

  // Final progress save
  saveUrlProgress(progressPath);
  console.log(`📋 Progress saved to: ${progressPath}`);

  // Print summary
  const completed = urlProgress.urls.filter(u => u.status === 'completed').length;
  const failed = urlProgress.urls.filter(u => u.status === 'failed').length;
  const pending = urlProgress.urls.filter(u => u.status === 'pending').length;

  console.log();
  console.log('📊 Scraping Summary:');
  console.log(`   Total URLs: ${urlProgress.urls.length}`);
  console.log(`   ✅ Completed: ${completed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   ⏳ Pending: ${pending}`);
  console.log();

  // Send completion notification
  if (allCards.length > 0) {
    sendNotification('Scraping Complete!', `${allCards.length} cards from ${setsData.length} sets`, 'info');
  } else {
    sendNotification('Scraping Complete', 'No cards collected', 'warning');
  }

  // Save failed sets log
  saveFailedSetsLog();
  console.log();

  // Save cards to JSON for later export - with set structure
  if (allCards.length > 0) {
    const cardsPath = path.resolve(__dirname, '..', 'output', 'cards.json');
    const outputData = {
      exportedAt: new Date().toISOString(),
      classUrl: CONFIG.classUrl,
      totalSets: setsData.length,
      totalCards: allCards.length,
      sets: setsData
    };
    require('fs').writeFileSync(cardsPath, JSON.stringify(outputData, null, 2));
    console.log(`Cards saved to: ${cardsPath}`);
    console.log();
  } else if (setsData.length > 0) {
    // Save even if no cards (empty sets)
    const cardsPath = path.resolve(__dirname, '..', 'output', 'cards.json');
    const outputData = {
      exportedAt: new Date().toISOString(),
      classUrl: CONFIG.classUrl,
      totalSets: setsData.length,
      totalCards: 0,
      sets: setsData
    };
    require('fs').writeFileSync(cardsPath, JSON.stringify(outputData, null, 2));
    console.log(`Empty sets saved to: ${cardsPath}`);
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
      const data = JSON.parse(require('fs').readFileSync(cardsPath, 'utf8'));
      
      // Handle both old format (array) and new format (object with sets)
      if (Array.isArray(data)) {
        allCards = data;
      } else if (data.sets && Array.isArray(data.sets)) {
        // New format with sets structure
        console.log(`Found ${data.totalSets || data.sets.length} sets`);
        // Flatten all cards from all sets
        data.sets.forEach(set => {
          if (set.cards && Array.isArray(set.cards)) {
            allCards.push(...set.cards);
          }
        });
      }
      
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
