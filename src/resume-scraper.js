const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const notifier = require('node-notifier');
const { downloadAllMedia } = require('./utils');
const { exportFlashcards } = require('./exporter');

/**
 * Sleep for a specified duration
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send desktop notification
 */
function sendNotification(title, message, urgency = 'info') {
  const icon = urgency === 'error' ? '❌' : urgency === 'warning' ? '⚠️' : '✅';
  notifier.notify({
    title: `${icon} ${title}`,
    message: message,
    sound: urgency === 'error' ? true : false,
    wait: false
  });
}

/**
 * Load existing cards.json and return set URLs that are already saved
 */
function getSavedSetUrls(cardsPath) {
  if (!fs.existsSync(cardsPath)) {
    return new Set();
  }
  
  const data = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
  const savedUrls = new Set();
  
  if (data.sets && Array.isArray(data.sets)) {
    data.sets.forEach(set => {
      if (set.setUrl) {
        savedUrls.add(set.setUrl);
      }
    });
  }
  
  return savedUrls;
}

/**
 * Update url-progress.json to mark unsaved URLs as pending
 */
function resetUnsavedUrls(progressPath, savedUrls) {
  if (!fs.existsSync(progressPath)) {
    console.log('❌ url-progress.json not found!');
    return false;
  }
  
  const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  let resetCount = 0;
  
  progress.urls.forEach(urlData => {
    if (!savedUrls.has(urlData.url)) {
      urlData.status = 'pending';
      urlData.error = null;
      urlData.cards = 0;
      resetCount++;
    }
  });
  
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');
  console.log(`🔄 Reset ${resetCount} URLs to 'pending' status`);
  
  return true;
}

/**
 * Scrape a single set
 */
async function scrapeSet(page, setUrl) {
  try {
    await page.goto(setUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Check for Cloudflare and wait for user to bypass it
    let attempts = 0;
    const maxAttempts = 60; // Wait up to 5 minutes (60 * 5 seconds)
    
    while (attempts < maxAttempts) {
      const title = await page.title();
      const url = page.url();
      const isCloudflare = title.includes('Cloudflare') || 
                          title.includes('Just a moment') || 
                          title.includes('Один момент') ||
                          title.includes('Прежде чем мы продолжим') ||
                          url.includes('challenges.cloudflare.com');
      
      if (isCloudflare) {
        if (attempts === 0) {
          console.log(`  ⚠️  CLOUDFLARE DETECTED!`);
          console.log(`      Please complete the challenge manually in the browser window`);
          console.log(`      (Click and hold the button if shown)`);
          sendNotification('Cloudflare Challenge', 'Please complete verification in browser', 'warning');
        }
        if (attempts % 3 === 0) {
          console.log(`      Still waiting... (${attempts * 5}s elapsed)`);
        }
        await sleep(5000);
        attempts++;
      } else {
        if (attempts > 0) {
          console.log(`  ✅ Cloudflare bypassed! Continuing...`);
          sendNotification('Cloudflare Passed', 'Resuming scraping', 'info');
        }
        break;
      }
    }
    
    if (attempts >= maxAttempts) {
      console.log(`  ⚠️  Cloudflare timeout, skipping...`);
      return { error: 'cloudflare', cards: [] };
    }

    await page.waitForTimeout(2000);

    // Scroll to load cards
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    // Extract cards
    const cards = await page.evaluate(() => {
      const cards = [];
      const termElements = document.querySelectorAll('[data-term]');

      termElements.forEach(term => {
        const front = term.querySelector('[data-side="front"]')?.textContent?.trim() ||
                     term.querySelector('.TermText:not(.hidden)')?.textContent?.trim() || '';
        const back = term.querySelector('[data-side="back"]')?.textContent?.trim() ||
                    term.querySelectorAll('.TermText:not(.hidden)')?.[1]?.textContent?.trim() || '';

        const img = term.querySelector('img[src*="quizlet.com"]');
        const imageUrl = img ? img.src : null;

        const audioBtn = term.querySelector('[data-role="audio"], .audio-button');
        const audioUrl = audioBtn ? (audioBtn.getAttribute('data-audio-url') || audioBtn.getAttribute('data-src')) : null;

        if (front && back) {
          cards.push({
            front: front.replace(/\n/g, ' ').replace(/\s+/g, ' '),
            back: back.replace(/\n/g, ' ').replace(/\s+/g, ' '),
            imageUrl,
            audioUrl
          });
        }
      });

      // Fallback
      if (cards.length === 0) {
        const allTerms = document.querySelectorAll('.TermText');
        for (let i = 0; i < allTerms.length; i += 2) {
          const front = allTerms[i]?.textContent?.trim() || '';
          const back = allTerms[i + 1]?.textContent?.trim() || '';
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

    const setTitle = await page.evaluate(() => 
      document.querySelector('h1')?.textContent?.trim() || 'Untitled Set'
    );

    return { 
      title: setTitle, 
      cards: cards.map(c => ({ ...c, setName: setTitle, setUrl: setUrl })) 
    };

  } catch (error) {
    return { error: error.message, cards: [] };
  }
}

/**
 * Main function
 */
async function resumeScraping() {
  console.log('='.repeat(60));
  console.log('Resume Scraper - Scrape unsaved sets');
  console.log('='.repeat(60));

  const projectRoot = path.resolve(__dirname, '..');
  const cardsPath = path.join(projectRoot, 'output', 'cards.json');
  const progressPath = path.join(projectRoot, 'url-progress.json');

  // Load existing data
  console.log('\n📂 Loading existing data...');
  const savedUrls = getSavedSetUrls(cardsPath);
  console.log(`   Already saved: ${savedUrls.size} sets`);

  if (!fs.existsSync(progressPath)) {
    console.log('❌ url-progress.json not found! Run scraper first.');
    process.exit(1);
  }

  const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  console.log(`   Total URLs in progress: ${progress.urls.length}`);

  // Find unsaved URLs
  const unsavedUrls = progress.urls.filter(u => !savedUrls.has(u.url));
  console.log(`   Unsaved URLs: ${unsavedUrls.length}`);

  if (unsavedUrls.length === 0) {
    console.log('\n✅ All URLs are already saved!');
    console.log('You can now run: npm run anki');
    return;
  }

  // Reset unsaved URLs to pending
  console.log('\n🔄 Marking unsaved URLs as pending...');
  resetUnsavedUrls(progressPath, savedUrls);

  // Load existing cards data
  let existingData = {
    exportedAt: new Date().toISOString(),
    classUrl: progress.classUrl,
    totalSets: savedUrls.size,
    totalCards: 0,
    sets: []
  };

  if (fs.existsSync(cardsPath)) {
    existingData = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
    const totalCards = existingData.sets.reduce((sum, set) => sum + (set.cards?.length || 0), 0);
    existingData.totalCards = totalCards;
    console.log(`   Loaded ${existingData.sets.length} sets, ${totalCards} cards from cards.json`);
  }

  // Launch browser (visible mode for Cloudflare/CAPTCHA)
  console.log('\n🌐 Launching browser (visible mode)...');
  console.log('   Browser will stay open for Cloudflare/CAPTCHA handling');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
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

  // Navigate to Quizlet home first to handle Cloudflare once
  console.log('\n' + '='.repeat(60));
  console.log('⏸️  INITIAL CLOUDFLARE HANDLING');
  console.log('=' .repeat(60));
  console.log('Navigating to Quizlet.com...');
  await page.goto('https://quizlet.com', { waitUntil: 'domcontentloaded' });
  console.log('\n⏱️  PAUSING FOR 60 SECONDS');
  console.log('Use this time to:');
  console.log('1. Complete Cloudflare challenge if it appears');
  console.log('2. Log in to your Quizlet account if needed');
  console.log('3. Script will start scraping in 60 seconds...');
  console.log('=' .repeat(60));
  sendNotification('Starting Soon', 'Complete Cloudflare now!', 'warning');
  
  for (let i = 60; i > 0; i--) {
    process.stdout.write(`\r   Starting in: ${i} seconds...`);
    await sleep(1000);
  }
  console.log('\n✅ Starting scraping...\n');

  // Scrape unsaved sets
  console.log('\n' + '-'.repeat(60));
  console.log('Scraping unsaved sets...');
  console.log('-'.repeat(60));

  let newSets = [];
  let newCards = [];
  let failedCount = 0;

  for (let i = 0; i < unsavedUrls.length; i++) {
    const urlData = unsavedUrls[i];
    const urlIndex = progress.urls.findIndex(u => u.url === urlData.url);
    
    console.log(`\n[${i + 1}/${unsavedUrls.length}] ${urlData.url}`);

    const result = await scrapeSet(page, urlData.url);

    if (result.error) {
      console.log(`  ❌ Error: ${result.error}`);
      failedCount++;
      if (urlIndex >= 0) {
        progress.urls[urlIndex].status = 'failed';
        progress.urls[urlIndex].error = result.error;
      }
      await sleep(2000);
      continue;
    }

    if (result.cards.length === 0) {
      console.log(`  ⚠️  No cards found`);
      if (urlIndex >= 0) {
        progress.urls[urlIndex].status = 'completed';
        progress.urls[urlIndex].cards = 0;
      }
      await sleep(1000);
      continue;
    }

    console.log(`  ✅ Scraped ${result.cards.length} cards from "${result.title.substring(0, 40)}..."`);

    // Add to new sets
    newSets.push({
      setName: result.title,
      setUrl: urlData.url,
      cards: result.cards
    });

    newCards.push(...result.cards);

    // Update progress
    if (urlIndex >= 0) {
      progress.urls[urlIndex].status = 'completed';
      progress.urls[urlIndex].cards = result.cards.length;
      progress.urls[urlIndex].error = null;
    }

    // Save progress
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');

    // Save cards incrementally
    existingData.sets.push({
      setName: result.title,
      setUrl: urlData.url,
      cards: result.cards
    });
    existingData.totalSets = existingData.sets.length;
    existingData.totalCards = existingData.sets.reduce((sum, set) => sum + (set.cards?.length || 0), 0);
    existingData.exportedAt = new Date().toISOString();
    
    fs.writeFileSync(cardsPath, JSON.stringify(existingData, null, 2), 'utf8');
    console.log(`  💾 Saved to cards.json (total: ${existingData.totalSets} sets, ${existingData.totalCards} cards)`);

    await sleep(1500);
  }

  await browser.close();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Scraping Complete!');
  console.log('='.repeat(60));
  console.log(`\n📊 Results:`);
  console.log(`   New sets scraped: ${newSets.length}`);
  console.log(`   New cards added: ${newCards.length}`);
  console.log(`   Failed: ${failedCount}`);
  console.log(`\n📁 Total in cards.json:`);
  console.log(`   Sets: ${existingData.totalSets}`);
  console.log(`   Cards: ${existingData.totalCards}`);
  console.log(`\n✅ Ready to generate Anki packages: npm run anki`);
  console.log('='.repeat(60));
}

resumeScraping().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
