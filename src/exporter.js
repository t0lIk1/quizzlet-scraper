const fs = require('fs');
const path = require('path');
const createAPKG = require('anki-apkg-export').default;

/**
 * Export flashcards to CSV format
 * @param {Array} cards - Array of flashcard objects
 * @param {string} outputPath - Path to save the CSV file
 * @param {string} setTitle - Title of the flashcard set
 * @returns {Promise<string>} - Path to the saved file
 */
async function exportToCSV(cards, outputPath, setTitle = 'Quizlet Export') {
  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // CSV header
  let csv = 'Front;Back;Image;Audio\n';

  // Add each card as a row
  for (const card of cards) {
    // Escape semicolons and quotes in text
    const front = escapeCSV(card.front);
    const back = escapeCSV(card.back);
    
    // Format image HTML for Anki (if available)
    const image = card.localImagePath 
      ? `<img src="${card.localImagePath}" />` 
      : '';
    
    // Format audio HTML for Anki (if available)
    const audio = card.localAudioPath 
      ? `[sound:${path.basename(card.localAudioPath)}]` 
      : '';

    csv += `${front};${back};${image};${audio}\n`;
  }

  // Write to file
  fs.writeFileSync(outputPath, csv, 'utf8');
  console.log(`CSV exported to: ${outputPath}`);
  console.log(`Total cards: ${cards.length}`);
  
  return outputPath;
}

/**
 * Escape special characters for CSV
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
function escapeCSV(text) {
  if (!text) return '';
  // Escape quotes and wrap in quotes if contains semicolon or quote
  let escaped = text.replace(/"/g, '""');
  if (escaped.includes(';') || escaped.includes('"') || escaped.includes('\n')) {
    escaped = `"${escaped}"`;
  }
  return escaped;
}

/**
 * Export flashcards to APKG format (Anki package)
 * @param {Array} cards - Array of flashcard objects
 * @param {string} outputPath - Path to save the APKG file
 * @param {string} setTitle - Title of the deck
 * @param {string} mediaFolder - Folder containing media files
 * @returns {Promise<string>} - Path to the saved file
 */
async function exportToAPKG(cards, outputPath, setTitle = 'Quizlet Export', mediaFolder = 'media') {
  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create deck configuration
  const deck = {
    title: setTitle,
    cards: []
  };

  // Collect all media files to include
  const mediaFiles = new Map(); // filename -> full path

  // Process each card
  for (const card of cards) {
    const frontParts = [];
    const backParts = [];

    // Add text content
    frontParts.push(card.front);
    backParts.push(card.back);

    // Add image if available
    if (card.localImagePath) {
      const imgFilename = path.basename(card.localImagePath);
      const imgTag = `<img src="${imgFilename}" />`;
      frontParts.push(imgTag);
      
      // Add to media files
      mediaFiles.set(imgFilename, card.localImagePath);
    }

    // Add audio if available
    if (card.localAudioPath) {
      const audioFilename = path.basename(card.localAudioPath);
      const audioTag = `[sound:${audioFilename}]`;
      backParts.push(audioTag);
      
      // Add to media files
      mediaFiles.set(audioFilename, card.localAudioPath);
    }

    // Create card with HTML content
    deck.cards.push({
      front: frontParts.join('<br>'),
      back: backParts.join('<br>')
    });
  }

  try {
    // Create APKG using the default export function
    const apkg = createAPKG(setTitle);

    // Add cards
    for (const card of deck.cards) {
      apkg.addCard(card.front, card.back);
    }

    // Add media files
    for (const [filename, filepath] of mediaFiles) {
      if (fs.existsSync(filepath)) {
        const fileContent = fs.readFileSync(filepath);
        apkg.addMedia(filename, fileContent);
      }
    }

    // Generate and save the APKG file
    const buffer = await apkg.save();
    fs.writeFileSync(outputPath, buffer);
    
    console.log(`APKG exported to: ${outputPath}`);
    console.log(`Total cards: ${cards.length}`);
    console.log(`Media files included: ${mediaFiles.size}`);

    return outputPath;
  } catch (error) {
    console.log(`APKG generation failed: ${error.message}`);
    console.log(`Falling back to CSV export...`);
    
    // Fallback to CSV
    return await exportToCSV(cards, outputPath.replace('.apkg', '.csv'), setTitle);
  }
}

/**
 * Export flashcards to specified format(s)
 * @param {Array} cards - Array of flashcard objects
 * @param {Object} options - Export options
 * @returns {Promise<Object>} - Paths to exported files
 */
async function exportFlashcards(cards, options) {
  const {
    outputFolder = 'output',
    filename = 'quizlet-export',
    format = 'both', // 'csv', 'apkg', or 'both'
    setTitle = 'Quizlet Export',
    mediaFolder = 'media'
  } = options;

  const results = {};

  // Ensure output folder exists
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  // Export to CSV
  if (format === 'csv' || format === 'both') {
    const csvPath = path.join(outputFolder, `${filename}.csv`);
    await exportToCSV(cards, csvPath, setTitle);
    results.csv = csvPath;
  }

  // Export to APKG
  if (format === 'apkg' || format === 'both') {
    const apkgPath = path.join(outputFolder, `${filename}.apkg`);
    await exportToAPKG(cards, apkgPath, setTitle, mediaFolder);
    results.apkg = apkgPath;
  }

  return results;
}

module.exports = {
  exportToCSV,
  exportToAPKG,
  exportFlashcards,
  escapeCSV
};
