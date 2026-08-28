const fs = require('fs');
const https = require('https');

const stopWords = ["the","and","but","for","not","with","from","that","this","they","are","was","were","been","his","her","she","him","had","has"];

const url = "https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-no-swears.txt";

https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const words = data.split('\n');
        const validWords = [];
        
        for (let w of words) {
            w = w.toLowerCase().trim();
            if (w.length >= 3 && !stopWords.includes(w) && /^[a-z]+$/.test(w)) {
                validWords.push(w);
            }
            if (validWords.length >= 5000) break;
        }

        const wordMap = {};
        for (const w of validWords) {
            const firstLetter = w[0];
            if (!wordMap[firstLetter]) wordMap[firstLetter] = [];
            wordMap[firstLetter].push(w);
        }

        const jsContent = `// Auto-generated 5000 most common words for lightning-fast lookups
const CPU_WORD_SET = new Set(${JSON.stringify(validWords)});
const CPU_WORD_MAP = ${JSON.stringify(wordMap)};
`;

        fs.writeFileSync('words.js', jsContent, 'utf-8');
        console.log(`Generated words.js with ${validWords.length} words.`);
    });
}).on('error', err => {
    console.error('Error fetching words:', err.message);
});
