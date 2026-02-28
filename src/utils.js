const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Download a file from URL and save it to the media folder
 * @param {string} url - The URL to download from
 * @param {string} mediaFolder - The folder to save the file to
 * @param {string} prefix - Prefix for the filename
 * @param {string} extension - File extension
 * @returns {Promise<string|null>} - Relative path to the downloaded file or null if failed
 */
async function downloadMedia(url, mediaFolder, prefix, extension) {
  if (!url) return null;

  try {
    // Create media folder if it doesn't exist
    if (!fs.existsSync(mediaFolder)) {
      fs.mkdirSync(mediaFolder, { recursive: true });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);
    const filename = `${prefix}_${timestamp}_${randomId}${extension}`;
    const filepath = path.join(mediaFolder, filename);

    // Download the file
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    // Save the file
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        // Return relative path for Anki
        resolve(path.relative(process.cwd(), filepath).replace(/\\/g, '/'));
      });
      writer.on('error', (err) => {
        console.error(`Error saving file ${filename}:`, err.message);
        reject(err);
      });
    });

  } catch (error) {
    console.error(`Failed to download ${url}:`, error.message);
    return null;
  }
}

/**
 * Download all media (images and audio) for a set of flashcards
 * @param {Array} cards - Array of flashcard objects
 * @param {string} mediaFolder - The folder to save media files to
 * @param {number} delay - Delay between downloads in ms
 * @returns {Promise<Array>} - Updated cards array with local media paths
 */
async function downloadAllMedia(cards, mediaFolder, delay = 500) {
  const updatedCards = [];
  let imageCount = 0;
  let audioCount = 0;

  console.log(`Downloading media for ${cards.length} cards...`);

  for (const card of cards) {
    const updatedCard = { ...card };

    // Download image if available
    if (card.imageUrl) {
      const ext = path.extname(card.imageUrl.split('?')[0]) || '.jpg';
      const imagePath = await downloadMedia(card.imageUrl, mediaFolder, 'img', ext);
      if (imagePath) {
        updatedCard.localImagePath = imagePath;
        imageCount++;
        if (delay > 0) await sleep(delay);
      }
    }

    // Download audio if available
    if (card.audioUrl) {
      const ext = path.extname(card.audioUrl.split('?')[0]) || '.mp3';
      const audioPath = await downloadMedia(card.audioUrl, mediaFolder, 'audio', ext);
      if (audioPath) {
        updatedCard.localAudioPath = audioPath;
        audioCount++;
        if (delay > 0) await sleep(delay);
      }
    }

    updatedCards.push(updatedCard);
  }

  console.log(`Downloaded ${imageCount} images and ${audioCount} audio files`);
  return updatedCards;
}

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clean up media folder (optional utility)
 * @param {string} mediaFolder - The folder to clean
 */
function cleanMediaFolder(mediaFolder) {
  if (fs.existsSync(mediaFolder)) {
    const files = fs.readdirSync(mediaFolder);
    for (const file of files) {
      fs.unlinkSync(path.join(mediaFolder, file));
    }
    console.log(`Cleaned media folder: ${mediaFolder}`);
  }
}

module.exports = {
  downloadMedia,
  downloadAllMedia,
  cleanMediaFolder,
  sleep
};
