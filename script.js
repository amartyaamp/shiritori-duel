let ablyClient, channel, timerId;
let myScore = 100, oppScore = 100, timeLeft = 15.0;
let usedWords = new Set(), lastChar = "", amIHost = false, isMyTurn = false, gameMode = 'remote';
let gameOver = false; // guard against double-fire on disconnect
const ABLY_KEY = '0rH5ag.KR9ICA:0zqyTFNsnNxVRiej7nAkWgnS5Sv0-xQ0kD50Qq8BCRk';

const stopWords = ["the","and","but","for","not","with","from","that","this","they","are","was","were","been","his","her","she","him","had","has"];

// --- AUDIO SYSTEM ---
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function initAudio() {
    if (!audioCtx) audioCtx = new AudioContext();
}

function playTone(freq, type = 'sine', duration = 0.1, vol = 0.1) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    
    gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
}

function playValidWord() { playTone(600, 'sine', 0.15); setTimeout(() => playTone(800, 'sine', 0.2), 100); }
function playInvalidWord() { playTone(150, 'sawtooth', 0.3); }
function playVictory() { 
    [400, 500, 600, 800].forEach((f, i) => setTimeout(() => playTone(f, 'square', 0.2), i * 150));
}
function playDefeat() {
    [300, 250, 200, 150].forEach((f, i) => setTimeout(() => playTone(f, 'sawtooth', 0.3), i * 200));
}

// --- UI EFFECTS ---
function shakeInput() {
    const input = document.getElementById('word-input');
    input.classList.remove('shake');
    void input.offsetWidth; // trigger reflow
    input.classList.add('shake');
}

function spawnFloatingScore(cardId, amount) {
    const card = document.getElementById(cardId);
    const floatEl = document.createElement('div');
    floatEl.className = 'floating-score ' + (amount > 0 ? 'positive' : '');
    floatEl.textContent = (amount > 0 ? '+' : '') + amount.toFixed(1);
    
    // Position it roughly in the center of the card
    floatEl.style.left = '50%';
    floatEl.style.top = '40%';
    floatEl.style.transform = 'translate(-50%, -50%)';
    
    card.appendChild(floatEl);
    setTimeout(() => floatEl.remove(), 1000);
}

// --- GAME LOGIC ---

function showScreen(id) {
    initAudio(); // Initialize audio context on first user interaction
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
}

function abandonShip() {
    if (gameOver) return;
    gameOver = true;
    if (ablyClient) ablyClient.close();
    window.location.reload();
}

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function initRemote(isHost) {
    initAudio();
    amIHost = isHost;
    gameOver = false;

    // Each player gets a unique clientId so we can tell them apart in presence
    const playerId = Math.random().toString(36).substring(2);
    ablyClient = new Ably.Realtime({ key: ABLY_KEY, clientId: playerId });

    let roomCode;
    if (isHost) {
        roomCode = generateRoomCode();
        document.getElementById('my-id-display').textContent = roomCode;
        showScreen('lobby');
    } else {
        roomCode = document.getElementById('join-id').value.trim().toUpperCase();
        if (!roomCode) { alert("Need a Room Code, friend."); return; }
    }

    channel = ablyClient.channels.get(`shiritori-${roomCode}`);

    // Enter presence so each side knows when the other disconnects
    await channel.presence.enter();
    channel.presence.subscribe('leave', (member) => {
        if (member.clientId !== playerId && !gameOver) {
            alert("Opponent disconnected.");
            abandonShip();
        }
    });

    ablyClient.connection.on('failed', () => {
        if (!gameOver) { alert("Connection to Ably failed."); abandonShip(); }
    });

    if (isHost) {
        // Wait for the joiner to signal they're in
        channel.subscribe('player-joined', () => {
            channel.unsubscribe('player-joined');
            channel.publish('game-start', {});
            setupAblyGame();
        });
    } else {
        // Wait for the host's start signal
        channel.subscribe('game-start', () => {
            channel.unsubscribe('game-start');
            setupAblyGame();
        });
        // Tell the host we've arrived
        channel.publish('player-joined', {});
    }
}

function setupAblyGame() {
    showScreen('game');
    document.getElementById('name-p1').textContent = amIHost ? 'YOU' : 'THEM';
    document.getElementById('name-p2').textContent = amIHost ? 'THEM' : 'YOU';

    // Ably delivers messages to ALL subscribers including the publisher.
    // msg.clientId tells us who sent it — skip our own messages to avoid echo.
    channel.subscribe('move', (msg) => {
        if (msg.clientId === ablyClient.auth.clientId) return;
        receiveMove(msg.data);
    });
    channel.subscribe('forfeit', (msg) => {
        if (msg.clientId === ablyClient.auth.clientId) return;
        playVictory();
        alert("They surrendered! A victory for the history books.");
        abandonShip();
    });

    if (amIHost) { isMyTurn = true; startTurn(); } else { setTurnUI(); }
}

// Secondary validator: check Datamuse when the primary dictionary API misses a word.
async function isKnownWord(word) {
    try {
        const res = await fetch(
            `https://api.datamuse.com/words?sp=${word}&max=1`,
            { signal: AbortSignal.timeout(3000) }
        );
        const data = await res.json();
        // Accept if Datamuse returns an exact lowercase match
        return data.length > 0 && data[0].word.toLowerCase() === word;
    } catch {
        return false;
    }
}

function resumeTimer() {
    timerId = setInterval(() => {
        timeLeft -= 0.1;
        const t = document.getElementById('timer');
        t.textContent = timeLeft.toFixed(1);
        t.className = timeLeft < 0 ? 'timer-danger' : '';
    }, 100);
}

async function handleSend() {
    const input = document.getElementById('word-input');
    const sendBtn = document.getElementById('send-btn');
    const word = input.value.toLowerCase().trim();
    const fb = document.getElementById('feedback');

    if (input.disabled || sendBtn.disabled) return;

    input.disabled = true;
    sendBtn.disabled = true;

    fb.textContent = "Checking...";
    
    // Pause timer during network request so player isn't penalized for latency
    clearInterval(timerId);

    function errorFeedback(msg) {
        fb.textContent = msg;
        shakeInput();
        playInvalidWord();
        input.disabled = false;
        sendBtn.disabled = false;
        if (isMyTurn) input.focus();
        resumeTimer(); // Resume if the word was rejected
    }

    if (word.length < 3) { errorFeedback("3+ letters! Don't be lazy."); return; }
    if (lastChar && word[0] !== lastChar) { errorFeedback(`Must start with ${lastChar.toUpperCase()}!`); return; }
    if (usedWords.has(word)) { errorFeedback("Old news. Pick another."); return; }
    if (stopWords.includes(word)) { errorFeedback("Stop-words are forbidden."); return; }

    function acceptWord() {
        const delta = -timeLeft;
        myScore = Math.round((myScore + delta) * 10) / 10;
        spawnFloatingScore(amIHost ? 'card-p1' : 'card-p2', delta);
        
        updateScoreDisplay();
        playValidWord();

        if (gameMode === 'remote') channel.publish('move', { word, score: myScore });
        logWord(word, 'me');
        finishMove(word);

        if (myScore <= 0) { 
            playVictory();
            setTimeout(() => { alert("VICTORY ACHIEVED!"); abandonShip(); }, 500);
        }
        else if (gameMode === 'solo') runCpuTurn();
        else { isMyTurn = false; setTurnUI(); }
    }

    if (typeof CPU_WORD_SET !== 'undefined' && CPU_WORD_SET.has(word)) {
        acceptWord();
        return; // Fast path! 0ms latency for common words!
    }

    try {
        // Fire both APIs in parallel
        const [primaryResult, datamuse] = await Promise.allSettled([
            fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`).then(r => r.ok ? r.json() : null),
            isKnownWord(word)
        ]);

        const primaryData = primaryResult.status === 'fulfilled' ? primaryResult.value : null;
        const knownByDatamuse = datamuse.status === 'fulfilled' ? datamuse.value : false;

        if (primaryData) {
            // Primary succeeded — check for proper nouns using its data
            if (primaryData[0].word[0] === primaryData[0].word[0].toUpperCase()) { errorFeedback("Proper Nouns are banned."); return; }
        } else if (!knownByDatamuse) {
            // Both failed — genuinely not a word
            errorFeedback("Not a real word!"); return;
        }

        // Learn the new word dynamically!
        if (typeof CPU_WORD_SET !== 'undefined' && typeof CPU_WORD_MAP !== 'undefined') {
            CPU_WORD_SET.add(word);
            const firstLetter = word[0];
            if (!CPU_WORD_MAP[firstLetter]) CPU_WORD_MAP[firstLetter] = [];
            if (!CPU_WORD_MAP[firstLetter].includes(word)) {
                CPU_WORD_MAP[firstLetter].push(word);
            }
        }

        acceptWord();
    } catch (e) { errorFeedback("Dictionary API is acting up."); }
}

function receiveMove(data) {
    clearInterval(timerId);
    
    const delta = data.score - oppScore;
    oppScore = data.score;
    
    updateScoreDisplay();
    spawnFloatingScore(amIHost ? 'card-p2' : 'card-p1', delta);
    playValidWord();
    
    logWord(data.word, 'them');
    finishMove(data.word);

    // If opponent's score just hit zero, they win — show a lose message
    if (oppScore <= 0) {
        playDefeat();
        setTimeout(() => {
            alert("Your opponent has reached zero. You lose this round — train harder.");
            abandonShip();
        }, 500);
        return;
    }

    isMyTurn = true;
    startTurn();
}

function finishMove(word) {
    usedWords.add(word);
    lastChar = word.slice(-1);
    document.getElementById('target-letter').textContent = lastChar.toUpperCase();
    document.getElementById('word-input').value = "";
    document.getElementById('feedback').textContent = "";
}

function startTurn() {
    timeLeft = 15.0;
    setTurnUI();

    // First turn: no chain constraint yet
    if (!lastChar && isMyTurn) {
        document.getElementById('feedback').textContent = '💡 First word is yours — any word (3+ letters, no proper nouns).';
    }

    timerId = setInterval(() => {
        timeLeft -= 0.1;
        const t = document.getElementById('timer');
        t.textContent = timeLeft.toFixed(1);
        t.className = timeLeft < 0 ? 'timer-danger' : '';
    }, 100);
}

function setTurnUI() {
    const input = document.getElementById('word-input');
    const sendBtn = document.getElementById('send-btn');
    input.disabled = !isMyTurn;
    sendBtn.disabled = !isMyTurn;
    if (isMyTurn) input.focus();
    
    const myTurnNow = ((amIHost && isMyTurn) || (!amIHost && !isMyTurn));
    const theirTurnNow = ((!amIHost && isMyTurn) || (amIHost && !isMyTurn));
    
    document.getElementById('card-p1').className = `score-card ${myTurnNow ? 'active-turn' : ''}`;
    document.getElementById('card-p2').className = `score-card ${theirTurnNow ? 'active-turn' : ''}`;
}

function updateScoreDisplay() {
    document.getElementById(amIHost ? 'score-p1' : 'score-p2').textContent = myScore;
    document.getElementById(amIHost ? 'score-p2' : 'score-p1').textContent = oppScore;
}

function logWord(word, who) {
    const div = document.createElement('div');
    div.className = `msg-row msg-${who}`;
    div.textContent = word.toUpperCase();
    document.getElementById('history').appendChild(div);
    document.getElementById('history').scrollTop = 9999;
}

function handleForfeit() { 
    if (channel) channel.publish('forfeit', {}); 
    playDefeat();
    alert("You surrendered. Shameful display.");
    abandonShip(); 
}
function copyId() { navigator.clipboard.writeText(document.getElementById('my-id-display').textContent); alert("Room Code copied!"); }

function startSolo() {
    initAudio();
    gameMode = 'solo'; amIHost = true; isMyTurn = true;
    showScreen('game'); startTurn();
}



// Fetch candidate words from Datamuse API starting with `letter`.
async function fetchDatamuseWords(letter) {
    try {
        const res = await fetch(
            `https://api.datamuse.com/words?sp=${letter}*&max=100&md=p`,
            { signal: AbortSignal.timeout(4000) }
        );
        const data = await res.json();
        return data
            .filter(d => !d.tags || !d.tags.includes('prop')) // drop proper nouns
            .map(d => d.word.toLowerCase())
            .filter(w => w.length >= 3 && /^[a-z]+$/.test(w)); // single words, 3+ letters
    } catch {
        return []; // network error or timeout → local bank fallback kicks in
    }
}

// Shared filter: apply all game rules to a candidate list
function filterCandidates(words) {
    const required = lastChar.toLowerCase();
    return words.filter(w =>
        (!required || w[0] === required) &&
        !usedWords.has(w) &&
        !stopWords.includes(w)
    );
}

async function runCpuTurn() {
    isMyTurn = false; setTurnUI();

    const thinkTime = 100 + Math.random() * 300; // 0.1s – 0.4s

    // Fire the Datamuse fetch and the think-timer in parallel.
    const [apiResult] = await Promise.allSettled([
        fetchDatamuseWords(lastChar.toLowerCase()),
        new Promise(r => setTimeout(r, thinkTime))
    ]);

    // Primary: API words that pass all game rules
    let candidates = filterCandidates(
        apiResult.status === 'fulfilled' ? apiResult.value : []
    );

    // Fallback: local HashMap lookup for O(1) category access
    if (candidates.length === 0 && typeof CPU_WORD_MAP !== 'undefined') {
        const required = lastChar.toLowerCase();
        const possibleWords = CPU_WORD_MAP[required] || [];
        candidates = possibleWords.filter(w => !usedWords.has(w));
    }

    // Truly stuck — CPU concedes
    if (candidates.length === 0) {
        playVictory();
        setTimeout(() => {
            alert("The Machine has no valid move. You win by default!");
            abandonShip();
        }, 500);
        return;
    }

    const cpuWord = candidates[Math.floor(Math.random() * candidates.length)];

    // Deduct score based on actual think time (same formula as the player)
    const cpuTimeLeft = Math.max(0, 15 - thinkTime / 1000);
    const delta = -cpuTimeLeft;
    oppScore = Math.round((oppScore + delta) * 10) / 10;

    updateScoreDisplay();
    spawnFloatingScore('card-p2', delta);
    playValidWord();
    
    logWord(cpuWord, 'them');
    finishMove(cpuWord);

    if (oppScore <= 0) {
        playDefeat();
        setTimeout(() => {
            alert("The Machine has reached zero score. You lose... this time.");
            abandonShip();
        }, 500);
        return;
    }

    isMyTurn = true;
    startTurn();
}

document.getElementById('send-btn').onclick = handleSend;
document.getElementById('word-input').onkeypress = e => { if(e.key === 'Enter' && isMyTurn) handleSend(); };
