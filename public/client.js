// client.js
// Handles WebRTC, Socket.IO, Speech Recognition, and Translation.

const socket = io();

// DOM elements
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const captionOverlay = document.getElementById('caption-overlay');
const statusDiv = document.getElementById('status');
const errorModal = document.getElementById('error-modal');
const errorMessage = document.getElementById('error-message');
const closeModalBtn = document.getElementById('close-modal');

// WebRTC and App state
let localStream;
let peerConnection;
let myLanguage = '';
let targetLanguage = '';
const roomId = 'main-room'; // Static room for simplicity
let isRecognitionActive = false;

// WebRTC server configuration
const servers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};

// Speech Recognition setup
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true; 
    recognition.interimResults = true; // Get results faster
} else {
    showError("Speech Recognition API is not supported in this browser.");
}

// ---- UTILITY FUNCTIONS ----
function showError(message) {
    errorMessage.textContent = message;
    errorModal.classList.remove('hidden');
    errorModal.classList.add('flex');
}
closeModalBtn.addEventListener('click', () => {
    errorModal.classList.add('hidden');
    errorModal.classList.remove('flex');
});

function updateStatus(message) {
    statusDiv.textContent = message;
    statusDiv.style.display = message ? 'block' : 'none';
}

function addCaption(mainText, subText, isLocal) {
    const bubble = document.createElement('div');
    bubble.classList.add('caption-bubble', isLocal ? 'local-caption' : 'remote-caption');

    const mainTextSpan = document.createElement('span');
    mainTextSpan.textContent = mainText;
    mainTextSpan.classList.add('block');

    const subTextSpan = document.createElement('span');
    subTextSpan.textContent = subText;
    subTextSpan.classList.add('block', 'text-xs', 'opacity-80', 'mt-1');

    bubble.appendChild(mainTextSpan);
    bubble.appendChild(subTextSpan);
    captionOverlay.appendChild(bubble);
    captionOverlay.scrollTop = captionOverlay.scrollHeight;

    // Remove the caption after a delay
    setTimeout(() => bubble.remove(), 8000);
}


// ---- TRANSLATION ----
async function translateText(text, source, target) {
    if (!text) return null;
    const langPair = `${source}|${target}`;
    const apiUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;
    try {
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error(`API error: ${res.statusText}`);
        const data = await res.json();
        if (data.responseData && data.responseData.translatedText) {
            return data.responseData.translatedText;
        }
        throw new Error("No translation found.");
    } catch (error) {
        console.error("Translation failed:", error);
        return `Translation failed for: ${text}`;
    }
}


// ---- SPEECH RECOGNITION LOGIC ----
function startRecognition() {
    if (!recognition || !myLanguage || isRecognitionActive) return;
    
    isRecognitionActive = true;
    recognition.lang = myLanguage === 'en' ? 'en-US' : 'ja-JP';
    
    recognition.onresult = (event) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            }
        }
        
        if (finalTranscript) {
            handleSpokenText(finalTranscript.trim());
        }
    };
    
    recognition.onend = () => {
        console.log('Speech recognition service disconnected.');
        // If the call is still active, restart recognition.
        if (peerConnection && peerConnection.connectionState === 'connected') {
            console.log('Restarting recognition...');
            recognition.start();
        } else {
            isRecognitionActive = false;
        }
    };

    recognition.onerror = (event) => {
        console.error(`Speech recognition error: ${event.error}`);
        // The 'onend' event will fire after an error, which will handle restarting.
    };
    
    try {
        recognition.start();
        console.log(`Speech recognition started for ${recognition.lang}`);
    } catch(e) {
        console.error("Could not start recognition: ", e);
        isRecognitionActive = false;
    }
}

async function handleSpokenText(spokenText) {
    console.log('Recognized (final):', spokenText);
    const translatedText = await translateText(spokenText, myLanguage, targetLanguage);
    if (translatedText) {
        // Display locally
        addCaption(spokenText, translatedText, true);
        // Send to remote peer
        socket.emit('send-caption', {
            original: spokenText,
            translated: translatedText
        });
    }
}


// ---- WEBRTC & SOCKET.IO LOGIC ----
async function start() {
    try {
        updateStatus('Requesting camera and microphone...');
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        updateStatus('Connecting to peer...');
        socket.emit('join-room', roomId);
    } catch (error) {
        console.error('Error starting media devices.', error);
        showError('Could not access camera and microphone. Please check permissions and try again.');
        updateStatus('Failed to start. Please grant permissions.');
    }
}

socket.on('language-assigned', (lang) => {
    myLanguage = lang;
    targetLanguage = myLanguage === 'en' ? 'ja' : 'en';
    console.log(`Assigned language: ${myLanguage}. Translating to ${targetLanguage}.`);
    updateStatus('Waiting for another user to join...');
});

socket.on('room-full', () => {
    updateStatus('The room is full.');
    showError('This call already has two participants.');
});

socket.on('user-joined', (socketId) => {
    console.log('User joined:', socketId);
    updateStatus('User joined. Creating offer...');
    createPeerConnection(socketId);
    peerConnection.createOffer()
        .then(offer => peerConnection.setLocalDescription(offer))
        .then(() => {
            const payload = {
                target: socketId,
                caller: socket.id,
                sdp: peerConnection.localDescription
            };
            socket.emit('offer', payload);
            updateStatus('Connecting...');
        });
});

socket.on('offer', (payload) => {
    console.log('Received offer from', payload.caller);
    updateStatus('Incoming call. Answering...');
    createPeerConnection(payload.caller);
    peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp))
        .then(() => peerConnection.createAnswer())
        .then(answer => peerConnection.setLocalDescription(answer))
        .then(() => {
            const payload_answer = {
                target: payload.caller,
                caller: socket.id,
                sdp: peerConnection.localDescription
            };
            socket.emit('answer', payload_answer);
        });
});

socket.on('answer', (payload) => {
    console.log('Received answer from', payload.caller);
    peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp)).catch(e => console.error(e));
});

socket.on('ice-candidate', (payload) => {
    peerConnection.addIceCandidate(new RTCIceCandidate(payload.ice))
      .catch(e => console.error("Error adding received ice candidate", e));
});

socket.on('new-caption', (captionData) => {
    // Show received caption as a remote message
    addCaption(captionData.translated, captionData.original, false);
});

socket.on('user-left', (socketId) => {
    updateStatus('User has left the call.');
    remoteVideo.srcObject = null;
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if(recognition && isRecognitionActive){
        recognition.stop();
        isRecognitionActive = false;
    }
});


function createPeerConnection(partnerSocketId) {
    if (peerConnection) {
        console.log("Closing existing peer connection");
        peerConnection.close();
    }
    
    peerConnection = new RTCPeerConnection(servers);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: partnerSocketId,
                ice: event.candidate,
            });
        }
    };

    peerConnection.ontrack = (event) => {
        // When the remote video track is received, add it to the video element
        if (event.streams && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        } else {
            // Fallback for older browsers
            let inboundStream = new MediaStream(event.track);
            remoteVideo.srcObject = inboundStream;
        }
        updateStatus(''); // Clear status once video is streaming
    };
    
    peerConnection.onconnectionstatechange = (event) => {
        console.log("Connection state:", peerConnection.connectionState);
        if(peerConnection.connectionState === 'connected'){
            updateStatus('');
            // Start listening for speech once connected
            startRecognition();
        }
    };

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });
}

// Kick off the process
start();
