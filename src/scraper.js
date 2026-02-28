const { chromium } = require('playwright');
const path = require('path');

/**
 * Create a browser context with realistic settings
 * @param {boolean} headless - Run browser in headless mode
 * @param {string} userDataDir - Directory for persistent browser data
 * @returns {Promise<Object>} - Browser and context
 */
async function createBrowserContext(headless = true, userDataDir = null) {
  const browserArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process'
  ];

  const browser = await chromium.launch({
    headless,
    args: browserArgs
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    geolocation: { longitude: -74.0060, latitude: 40.7128 }, // NYC
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  // Add init script to evade bot detection
  await context.addInitScript(() => {
    // Override the navigator.webdriver property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });
    
    // Mock plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });
    
    // Mock languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });
    
    // Override the chrome property
    window.chrome = { runtime: {} };
    
    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
  });

  return { browser, context };
}

/**
 * Extract all flashcard set URLs from a Quizlet class page
 * @param {string} classUrl - The URL of the Quizlet class page
 * @param {boolean} headless - Run browser in headless mode
 * @returns {Promise<string[]>} - Array of set URLs
 */
async function getClassSetUrls(classUrl, headless = true) {
  const { browser, context } = await createBrowserContext(headless);
  const page = await context.newPage();

  try {
    console.log(`Navigating to class page: ${classUrl}`);
    await page.goto(classUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for sets to load
    await page.waitForSelector('[data-set-link], a[href*="/"]', { timeout: 10000 }).catch(() => {
      console.log('Waiting additional time for content...');
    });
    await page.waitForTimeout(2000);

    // Extract all set links from the page
    const setUrls = await page.evaluate(() => {
      const urls = new Set();
      
      // Find all links that look like flashcard sets
      const links = document.querySelectorAll('a[href*="/"]');
      links.forEach(link => {
        const href = link.href;
        // Quizlet set URLs are typically: https://quizlet.com/{id}/{slug}
        // They don't contain /class/, /study/, /learn/, /test/, /match/, /gravity/
        if (href.includes('/quizlet.com/') && 
            !href.includes('/class/') &&
            !href.includes('/study/') &&
            !href.includes('/learn/') &&
            !href.includes('/test/') &&
            !href.includes('/match/') &&
            !href.includes('/gravity/') &&
            !href.includes('/_/') &&
            !href.includes('#')) {
          // Clean the URL - remove query params and trailing slashes
          const cleanUrl = href.split('?')[0].split('#')[0];
          // Validate it looks like a set URL (has numeric ID)
          if (/\/quizlet\.com\/\d+\//.test(cleanUrl)) {
            urls.add(cleanUrl);
          }
        }
      });

      // Also check for set cards with specific data attributes
      const setCards = document.querySelectorAll('[data-setid], [data-testid="set-link"]');
      setCards.forEach(card => {
        const setId = card.getAttribute('data-setid');
        if (setId) {
          urls.add(`https://quizlet.com/${setId}`);
        }
      });

      return Array.from(urls);
    });

    console.log(`Found ${setUrls.length} unique set URLs`);
    return setUrls;

  } catch (error) {
    console.error('Error extracting set URLs:', error.message);
    // Take a screenshot for debugging
    await page.screenshot({ path: 'output/debug-class-page.png' }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

/**
 * Extract flashcards from a single Quizlet set page
 * @param {string} setUrl - The URL of the Quizlet set
 * @param {boolean} headless - Run browser in headless mode
 * @returns {Promise<Object>} - Flashcard data with terms, images, and audio
 */
async function getFlashcardSet(setUrl, headless = true) {
  const { browser, context } = await createBrowserContext(headless);
  const page = await context.newPage();

  try {
    console.log(`Scraping set: ${setUrl}`);
    await page.goto(setUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for flashcards to load
    await page.waitForSelector('[data-term], .SetPageTerm-card', { timeout: 10000 }).catch(() => {
      console.log('Waiting additional time for flashcards...');
    });
    await page.waitForTimeout(3000);

    // Try to click "Learn" or scroll to load all cards
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1000);

    // Extract flashcard data
    const flashcardData = await page.evaluate(() => {
      const cards = [];
      
      // Method 1: Look for data-term elements (Quizlet's internal structure)
      const termElements = document.querySelectorAll('[data-term]');
      
      if (termElements.length > 0) {
        termElements.forEach((term, index) => {
          try {
            const front = term.querySelector('[data-side="front"]')?.textContent?.trim() || 
                         term.querySelector('.TermText:not(.hidden)')?.textContent?.trim() ||
                         term.textContent?.trim() || '';
            
            const back = term.querySelector('[data-side="back"]')?.textContent?.trim() ||
                        term.querySelectorAll('.TermText:not(.hidden)')?.[1]?.textContent?.trim() ||
                        '';

            // Extract images
            const img = term.querySelector('img[src*="quizlet.com"]');
            const imageUrl = img ? img.src : null;

            // Extract audio (Quizlet uses audio buttons with data attributes)
            const audioBtn = term.querySelector('[data-role="audio"], .audio-button, [class*="audio"]');
            let audioUrl = null;
            if (audioBtn) {
              // Try to get audio URL from data attribute or onclick
              audioUrl = audioBtn.getAttribute('data-audio-url') || 
                        audioBtn.getAttribute('data-src') ||
                        audioBtn.getAttribute('src');
            }

            if (front && back) {
              cards.push({
                index,
                front: front.replace(/\n/g, ' ').replace(/\s+/g, ' '),
                back: back.replace(/\n/g, ' ').replace(/\s+/g, ' '),
                imageUrl,
                audioUrl
              });
            }
          } catch (e) {
            console.error('Error parsing term:', e);
          }
        });
      }

      // Method 2: Look for SetPageTerm-card structure
      if (cards.length === 0) {
        const cardElements = document.querySelectorAll('.SetPageTerm-card, [data-testid="term-card"]');
        cardElements.forEach((card, index) => {
          try {
            const textElements = card.querySelectorAll('.TermText, .term-text');
            const front = textElements[0]?.textContent?.trim() || '';
            const back = textElements[1]?.textContent?.trim() || '';

            const img = card.querySelector('img[src*="quizlet.com"]');
            const imageUrl = img ? img.src : null;

            if (front && back) {
              cards.push({
                index,
                front: front.replace(/\n/g, ' ').replace(/\s+/g, ' '),
                back: back.replace(/\n/g, ' ').replace(/\s+/g, ' '),
                imageUrl,
                audioUrl: null
              });
            }
          } catch (e) {
            console.error('Error parsing card:', e);
          }
        });
      }

      // Method 3: Look for any structured term/definition pairs
      if (cards.length === 0) {
        const allTerms = document.querySelectorAll('.TermText');
        for (let i = 0; i < allTerms.length; i += 2) {
          const front = allTerms[i]?.textContent?.trim() || '';
          const back = allTerms[i + 1]?.textContent?.trim() || '';
          
          if (front && back) {
            cards.push({
              index: cards.length,
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

    // Get set title
    const setTitle = await page.evaluate(() => {
      return document.querySelector('h1')?.textContent?.trim() || 
             document.querySelector('[data-testid="set-title"]')?.textContent?.trim() ||
             'Untitled Set';
    });

    console.log(`Extracted ${flashcardData.length} flashcards from "${setTitle}"`);
    
    // Take a screenshot for debugging if no cards found
    if (flashcardData.length === 0) {
      await page.screenshot({ path: 'output/debug-empty-set.png' }).catch(() => {});
      console.log('Screenshot saved for debugging: output/debug-empty-set.png');
    }

    return {
      title: setTitle,
      url: setUrl,
      cards: flashcardData
    };

  } catch (error) {
    console.error(`Error scraping set ${setUrl}:`, error.message);
    await page.screenshot({ path: 'output/debug-error-set.png' }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

module.exports = {
  getClassSetUrls,
  getFlashcardSet
};
