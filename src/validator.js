const fs = require('fs');
const path = require('path');

/**
 * Validate flashcard data integrity
 */
async function validateCards() {
  console.log('='.repeat(60));
  console.log('Card Integrity Validator');
  console.log('='.repeat(60));

  // Load cards.json
  const cardsPath = path.resolve(__dirname, '..', 'output', 'cards.json');

  if (!fs.existsSync(cardsPath)) {
    console.error('❌ cards.json not found!');
    console.error('   Please run: npm start');
    process.exit(1);
  }

  console.log(`\n📂 Loading: ${cardsPath}`);
  const data = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));

  const { sets, classUrl, totalSets, totalCards, exportedAt } = data;

  console.log(`\n📊 Overview:`);
  console.log(`   Class URL: ${classUrl}`);
  console.log(`   Exported at: ${exportedAt || 'N/A'}`);
  console.log(`   Total sets (metadata): ${totalSets}`);
  console.log(`   Total cards (metadata): ${totalCards}`);

  if (!sets || sets.length === 0) {
    console.error('\n❌ No sets found!');
    process.exit(1);
  }

  console.log(`   Sets loaded: ${sets.length}`);

  // Validation results
  const issues = {
    emptyFront: [],
    emptyBack: [],
    identicalFrontBack: [],
    duplicates: [],
    missingSetUrl: [],
    missingSetUrlInCards: [],
    setCardCountMismatch: []
  };

  let totalCardsFound = 0;
  const allCards = new Map(); // front+back -> count

  // Validate each set
  console.log('\n' + '-'.repeat(60));
  console.log('Validating sets...');
  console.log('-'.repeat(60));

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    const { setName, setUrl, cards } = set;

    console.log(`\n[${i + 1}/${sets.length}] ${setName.substring(0, 50)}...`);

    if (!setUrl) {
      issues.missingSetUrl.push({ index: i, setName });
      console.log(`   ⚠️  Missing set URL`);
    }

    if (!cards || cards.length === 0) {
      console.log(`   ⚠️  No cards in set`);
      continue;
    }

    totalCardsFound += cards.length;

    // Track cards in this set for duplicate detection
    const setCards = new Map();

    for (let j = 0; j < cards.length; j++) {
      const card = cards[j];

      // Check empty front
      if (!card.front || card.front.trim() === '') {
        issues.emptyFront.push({
          set: setName.substring(0, 40),
          cardIndex: j,
          back: card.back?.substring(0, 30)
        });
      }

      // Check empty back
      if (!card.back || card.back.trim() === '') {
        issues.emptyBack.push({
          set: setName.substring(0, 40),
          cardIndex: j,
          front: card.front?.substring(0, 30)
        });
      }

      // Check identical front and back
      if (card.front && card.back && card.front.trim() === card.back.trim()) {
        issues.identicalFrontBack.push({
          set: setName.substring(0, 40),
          cardIndex: j,
          text: card.front?.substring(0, 30)
        });
      }

      // Check missing setUrl in card
      if (!card.setUrl) {
        issues.missingSetUrlInCards.push({
          set: setName.substring(0, 40),
          cardIndex: j
        });
      }

      // Check for duplicates within set
      const cardKey = `${card.front}|${card.back}`;
      if (setCards.has(cardKey)) {
        issues.duplicates.push({
          set: setName.substring(0, 40),
          cardIndex: j,
          front: card.front?.substring(0, 30),
          back: card.back?.substring(0, 30)
        });
      }
      setCards.set(cardKey, true);

      // Check for duplicates across sets
      const globalKey = `${card.front}|${card.back}`;
      if (allCards.has(globalKey)) {
        allCards.get(globalKey).count++;
      } else {
        allCards.set(globalKey, { set: setName, count: 1 });
      }
    }

    console.log(`   Cards: ${cards.length}`);
  }

  // Find cards that appear in multiple sets (count > 1)
  const crossSetDuplicates = [];
  for (const [key, value] of allCards) {
    if (value.count > 1) {
      const [front] = key.split('|');
      crossSetDuplicates.push({
        front: front?.substring(0, 30),
        count: value.count,
        firstSet: value.set
      });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Validation Summary');
  console.log('='.repeat(60));

  console.log(`\n📊 Statistics:`);
  console.log(`   Total sets: ${sets.length}`);
  console.log(`   Total cards found: ${totalCardsFound}`);
  console.log(`   Metadata totalCards: ${totalCards}`);
  console.log(`   Match: ${totalCardsFound === totalCards ? '✅' : '⚠️  MISMATCH'}`);

  const totalIssues = 
    issues.emptyFront.length +
    issues.emptyBack.length +
    issues.identicalFrontBack.length +
    issues.duplicates.length +
    issues.missingSetUrl.length +
    issues.missingSetUrlInCards.length;

  console.log(`\n⚠️  Issues found: ${totalIssues}`);

  if (issues.emptyFront.length > 0) {
    console.log(`\n   Empty Front: ${issues.emptyFront.length}`);
    issues.emptyFront.slice(0, 5).forEach(issue => {
      console.log(`      • Set: "${issue.set}...", Back: "${issue.back}"`);
    });
    if (issues.emptyFront.length > 5) console.log(`      ... and ${issues.emptyFront.length - 5} more`);
  }

  if (issues.emptyBack.length > 0) {
    console.log(`\n   Empty Back: ${issues.emptyBack.length}`);
    issues.emptyBack.slice(0, 5).forEach(issue => {
      console.log(`      • Set: "${issue.set}...", Front: "${issue.front}"`);
    });
    if (issues.emptyBack.length > 5) console.log(`      ... and ${issues.emptyBack.length - 5} more`);
  }

  if (issues.identicalFrontBack.length > 0) {
    console.log(`\n   Identical Front/Back: ${issues.identicalFrontBack.length}`);
    issues.identicalFrontBack.slice(0, 5).forEach(issue => {
      console.log(`      • Set: "${issue.set}...", Text: "${issue.text}"`);
    });
    if (issues.identicalFrontBack.length > 5) console.log(`      ... and ${issues.identicalFrontBack.length - 5} more`);
  }

  if (issues.duplicates.length > 0) {
    console.log(`\n   Duplicates (within sets): ${issues.duplicates.length}`);
    issues.duplicates.slice(0, 5).forEach(issue => {
      console.log(`      • Set: "${issue.set}...", Front: "${issue.front}"`);
    });
    if (issues.duplicates.length > 5) console.log(`      ... and ${issues.duplicates.length - 5} more`);
  }

  if (crossSetDuplicates.length > 0) {
    console.log(`\n   Cross-set duplicates: ${crossSetDuplicates.length}`);
    crossSetDuplicates.slice(0, 5).forEach(issue => {
      console.log(`      • "${issue.front}" appears in ${issue.count} sets (first: "${issue.firstSet.substring(0, 30)}...")`);
    });
    if (crossSetDuplicates.length > 5) console.log(`      ... and ${crossSetDuplicates.length - 5} more`);
  }

  if (issues.missingSetUrl.length > 0) {
    console.log(`\n   Missing Set URL: ${issues.missingSetUrl.length}`);
  }

  if (issues.missingSetUrlInCards.length > 0) {
    console.log(`\n   Missing Card Set URL: ${issues.missingSetUrlInCards.length}`);
  }

  // Save detailed report
  const reportPath = path.resolve(__dirname, '..', 'output', 'validation-report.json');
  const report = {
    validatedAt: new Date().toISOString(),
    statistics: {
      totalSets: sets.length,
      totalCardsFound,
      totalCardsMetadata: totalCards
    },
    issues: {
      emptyFront: issues.emptyFront,
      emptyBack: issues.emptyBack,
      identicalFrontBack: issues.identicalFrontBack,
      duplicatesWithinSets: issues.duplicates,
      crossSetDuplicates,
      missingSetUrl: issues.missingSetUrl,
      missingSetUrlInCards: issues.missingSetUrlInCards
    },
    summary: {
      totalIssues,
      hasCriticalIssues: totalIssues > 0
    }
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Detailed report saved: ${reportPath}`);

  console.log('\n' + '='.repeat(60));
  if (totalIssues === 0 && crossSetDuplicates.length === 0) {
    console.log('✅ All cards are valid!');
  } else {
    console.log('⚠️  Validation completed with issues');
  }
  console.log('='.repeat(60));
}

// Run validator
validateCards().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
