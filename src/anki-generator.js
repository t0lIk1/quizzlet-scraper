const fs = require('fs');
const path = require('path');
const axios = require('axios');
const createAPKG = require('anki-apkg-export').default;

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Download audio file from URL
 * @param {string} url - The URL to download from
 * @param {string} mediaFolder - The folder to save the file to
 * @param {string} filename - Filename for the audio file
 * @returns {Promise<string|null>} - Path to downloaded file or null
 */
async function downloadAudio(url, mediaFolder, filename) {
  if (!url) return null;

  try {
    if (!fs.existsSync(mediaFolder)) {
      fs.mkdirSync(mediaFolder, { recursive: true });
    }

    const filepath = path.join(mediaFolder, filename);

    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filepath));
      writer.on('error', reject);
    });

  } catch (error) {
    console.error(`Failed to download ${url}:`, error.message);
    return null;
  }
}

/**
 * Sanitize filename - remove invalid characters
 * @param {string} name - The name to sanitize
 * @returns {string} - Sanitized filename
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}

/**
 * Generate APKG for a single set
 * @param {Object} setData - The set data with cards
 * @param {string} outputFolder - Folder to save APKG files
 * @param {string} mediaFolder - Folder to store audio files
 * @returns {Promise<string>} - Path to generated APKG
 */
async function generateSetAPKG(setData, outputFolder, mediaFolder) {
  const { setName, setUrl, cards } = setData;

  if (!cards || cards.length === 0) {
    console.log(`  ⚠️  Skipping "${setName}" - no cards`);
    return null;
  }

  // Create deck name from set title
  const deckName = setName.replace('Flashcards | Quizlet', '').trim();
  const safeFilename = sanitizeFilename(deckName);

  console.log(`\n📦 Generating APKG for: ${deckName}`);
  console.log(`   Cards: ${cards.length}`);

  // Track media files
  const mediaFiles = new Map();
  let audioDownloaded = 0;
  let audioFailed = 0;

  // Cards storage
  const cardsData = [];

  // Process each card
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const frontParts = [];
    const backParts = [];

    // Add text content
    frontParts.push(card.front || '');
    backParts.push(card.back || '');

    // Add audio if available
    if (card.audioUrl) {
      const audioFilename = `audio_${safeFilename}_${i}.mp3`;
      const audioPath = await downloadAudio(card.audioUrl, mediaFolder, audioFilename);

      if (audioPath) {
        const audioTag = `[sound:${audioFilename}]`;
        backParts.push(audioTag);
        mediaFiles.set(audioFilename, audioPath);
        audioDownloaded++;
      } else {
        audioFailed++;
      }
    }

    // Store card data
    cardsData.push({
      front: frontParts.join('<br>'),
      back: backParts.join('<br>')
    });

    // Progress indicator
    if ((i + 1) % 10 === 0) {
      process.stdout.write(`\r   Processing cards: ${i + 1}/${cards.length}`);
    }
  }

  console.log(`\r   Processing cards: ${cards.length}/${cards.length} ✓`);
  console.log(`   Audio downloaded: ${audioDownloaded}, Failed: ${audioFailed || 0}`);

  try {
    // Create APKG using the default export function
    const apkg = createAPKG(deckName);

    // Add cards
    for (const card of cardsData) {
      apkg.addCard(card.front, card.back);
    }

    // Add media files
    for (const [filename, filepath] of mediaFiles) {
      if (fs.existsSync(filepath)) {
        const fileContent = fs.readFileSync(filepath);
        apkg.addMedia(filename, fileContent);
      }
    }

    // Generate and save APKG
    const buffer = await apkg.save();
    const apkgPath = path.join(outputFolder, `${safeFilename}.apkg`);
    fs.writeFileSync(apkgPath, buffer);

    console.log(`   ✅ APKG saved: ${apkgPath}`);
    console.log(`   📊 Total media files: ${mediaFiles.size}`);

    return apkgPath;
  } catch (error) {
    console.log(`   ⚠️  APKG generation failed: ${error.message}`);
    console.log(`   Trying CSV export instead...`);
    
    // Fallback: export to CSV for large decks
    const csvPath = path.join(outputFolder, `${safeFilename}.csv`);
    let csv = 'Front;Back\n';
    for (const card of cardsData) {
      csv += `${card.front};${card.back}\n`;
    }
    fs.writeFileSync(csvPath, csv, 'utf8');
    console.log(`   📄 CSV saved instead: ${csvPath}`);
    
    return csvPath;
  }
}

/**
 * Main function - generate APKG files for all sets
 */
async function generateAnkiPackages() {
  console.log('='.repeat(60));
  console.log('Anki Package Generator');
  console.log('='.repeat(60));

  // Load cards.json
  const cardsPath = path.resolve(__dirname, '..', 'output', 'cards.json');

  if (!fs.existsSync(cardsPath)) {
    console.error('❌ cards.json not found!');
    console.error('   Please run the scraper first: npm start');
    process.exit(1);
  }

  console.log(`\n📂 Loading: ${cardsPath}`);
  const data = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));

  const { sets, classUrl, totalSets, totalCards } = data;

  console.log(`   Class URL: ${classUrl}`);
  console.log(`   Total sets: ${totalSets}`);
  console.log(`   Total cards: ${totalCards}`);

  if (!sets || sets.length === 0) {
    console.log('\n⚠️  No sets found in cards.json');
    process.exit(0);
  }

  // Create output folders
  const projectRoot = path.resolve(__dirname, '..');
  const outputFolder = path.join(projectRoot, 'anki-output');
  const mediaFolder = path.join(outputFolder, 'media');

  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
    console.log(`\n📁 Created output folder: ${outputFolder}`);
  }

  if (!fs.existsSync(mediaFolder)) {
    fs.mkdirSync(mediaFolder, { recursive: true });
    console.log(`📁 Created media folder: ${mediaFolder}`);
  }

  // Generate APKG for each set
  console.log('\n' + '-'.repeat(60));
  console.log('Generating APKG files for each set...');
  console.log('-'.repeat(60));

  const results = {
    successful: [],
    failed: [],
    skipped: []
  };

  for (let i = 0; i < sets.length; i++) {
    const setData = sets[i];
    console.log(`\n[${i + 1}/${sets.length}]`);

    try {
      const apkgPath = await generateSetAPKG(setData, outputFolder, mediaFolder);

      if (apkgPath) {
        results.successful.push({
          setName: setData.setName,
          cards: setData.cards.length,
          path: apkgPath
        });
      } else {
        results.skipped.push(setData.setName);
      }

      // Small delay between sets
      await sleep(500);

    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
      results.failed.push({
        setName: setData.setName,
        error: error.message
      });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Complete!');
  console.log('='.repeat(60));
  console.log(`\n✅ Successful: ${results.successful.length}`);
  results.successful.forEach(r => {
    console.log(`   • ${r.setName.substring(0, 50)} (${r.cards} cards)`);
  });

  if (results.skipped.length > 0) {
    console.log(`\n⚠️  Skipped: ${results.skipped.length}`);
    results.skipped.forEach(name => {
      console.log(`   • ${name.substring(0, 50)}`);
    });
  }

  if (results.failed.length > 0) {
    console.log(`\n❌ Failed: ${results.failed.length}`);
    results.failed.forEach(r => {
      console.log(`   • ${r.setName.substring(0, 50)}: ${r.error}`);
    });
  }

  console.log(`\n📁 Output folder: ${outputFolder}`);
  console.log(`📁 Media folder: ${mediaFolder}`);
  console.log('\nImport the .apkg files into Anki using: File → Import');
  console.log('='.repeat(60));
}

// Run the generator
generateAnkiPackages().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
