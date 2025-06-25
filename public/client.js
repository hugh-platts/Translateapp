// client.js
// Handles WebRTC, Socket.IO, Speech Recognition, and all UI controls.

const socket = io();

// UI Elements
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const captionOverlay = document.getElementById('caption-overlay');
const joinBtn = document.getElementById('join-btn');
const endCallBtn = document.getElementById('end-call-btn');
const switchCameraBtn = document.getElementById('switch-camera-btn');
const statusOverlay = document.getElementById('status-overlay');
const statusText = document.getElementById('status-text');

// App State
let localStream;
let peerConnection;
let myLanguage = '';
let targetLanguage = '';
let isRecognitionActive = false;
let currentVideoDeviceIndex = 0;
let videoDevices = [];
const roomId = 'main-room';

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
    recognition.interimResults = true;
}

// --- UI MANAGEMENT ---
function showStatus(text) {
    statusOverlay.classList.remove('hidden');
    statusText.textContent = text;
    joinBtn.classList.add('hidden');
}

function showJoinUI(text = 'Ready to Join') {
    statusOverlay.classList.remove('hidden');
    statusText.textContent = text;
    joinBtn.classList.remove('hidden');
    endCallBtn.disabled = true;
    switchCameraBtn.disabled = true;
}

function hideOverlay() {
    statusOverlay.classList.add('hidden');
    endCallBtn.disabled = false;
    switchCameraBtn.disabled = false;
}

function addCaption(mainText, subText, isLocal) {
    const bubble = document.createElement('div');
    bubble.classList.add('caption-bubble', isLocal ? 'local-caption' : 'remote-caption');
    bubble.innerHTML = `<span class="block">${mainText}</span><span class="block text-xs opacity-80 mt-1">${subText}</span>`;
    captionOverlay.appendChild(bubble);
    captionOverlay.scrollTop = captionOverlay.scrollHeight;
    setTimeout(() => bubble.remove(), 8000);
}

// --- MEDIA HANDLING ---
async function startLocalMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        await getConnectedDevices();
    } catch (error) {
        console.error('Error starting media devices.', error);
        showJoinUI('Error: Could not access camera/mic.');
    }
}

async function getConnectedDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter(device => device.kind === 'videoinput');
    if (videoDevices.length > 1) {
        switchCameraBtn.disabled = false;
    }
}

async function switchCamera() {
    if (videoDevices.length < 2) return;
    currentVideoDeviceIndex = (currentVideoDeviceIndex + 1) % videoDevices.length;
    const deviceId = videoDevices[currentVideoDeviceIndex].deviceId;

    // Get new stream
    const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
        audio: true,
    });

    // Replace video track in local stream and peer connection
    const newVideoTrack = newStream.getVideoTracks()[0];
    const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
    if (sender) {
        sender.replaceTrack(newVideoTrack);
    }
    
    // Update local video element
    localStream.removeTrack(localStream.getVideoTracks()[0]);
    localStream.addTrack(newVideoTrack);
    localVideo.srcObject = localStream; // Re-assigning might be needed for some browsers
}


// --- SPEECH RECOGNITION & TRANSLATION ---
function startRecognition() {
    if (!recognition || !myLanguage || isRecognitionActive) return;
    isRecognitionActive = true;
    recognition.lang = myLanguage === 'en' ? 'en-US' : 'ja-JP';
    
    recognition.onresult = (event) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
        }
        if (finalTranscript) handleSpokenText(finalTranscript.trim());
    };
    
    recognition.onend = () => {
        if (isRecognitionActive) { // Only restart if we want it to be active
            recognition.start();
        }
    };
    recognition.start();
}

function stopRecognition() {
    if (recognition && isRecognitionActive) {
        isRecognitionActive = false;
        recognition.stop();
    }
}

async function handleSpokenText(text) {
    const translated = await translateText(text, myLanguage, targetLanguage);
    if (translated) {
        addCaption(text, translated, true);
        socket.emit('send-caption', { original: text, translated });
    }
}

async function translateText(text, source, target) {
    if (!text) return null;
    const langPair = `${source}|${target}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        return data.responseData.translatedText;
    } catch (e) {
        console.error("Translation failed:", e);
        return null;
    }
}

// --- WEBRTC & SOCKET.IO LOGIC ---
function joinCall() {
    showStatus('Connecting...');
    socket.emit('join-room', roomId);
}

function endCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    remoteVideo.srcObject = null;
    captionOverlay.innerHTML = '';
    stopRecognition();
    socket.emit('end-call');
    showJoinUI('Call Ended');
    startLocalMedia(); // Restart to show preview for next call
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = event => {
        remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', { target: remotePeerId, candidate: event.candidate });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
            hideOverlay();
            startRecognition();
        }
    };
}

let remotePeerId;

// Socket Event Listeners
socket.on('language-assigned', lang => {
    myLanguage = lang;
    targetLanguage = myLanguage === 'en' ? 'ja' : 'en';
});

socket.on('room-full', () => showStatus('Room is full.'));

socket.on('user-joined', ({ peerId }) => {
    remotePeerId = peerId;
    createPeerConnection();
    peerConnection.createOffer()
        .then(offer => peerConnection.setLocalDescription(offer))
        .then(() => {
            socket.emit('offer', { target: remotePeerId, sdp: peerConnection.localDescription });
        });
});

socket.on('offer', ({ sdp, caller }) => {
    remotePeerId = caller;
    createPeerConnection();
    peerConnection.setRemoteDescription(new RTCSessionDescription(sdp))
        .then(() => peerConnection.createAnswer())
        .then(answer => peerConnection.setLocalDescription(answer))
        .then(() => {
            socket.emit('answer', { target: remotePeerId, sdp: peerConnection.localDescription });
        });
});

socket.on('answer', ({ sdp }) => {
    peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('ice-candidate', ({ candidate }) => {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
});

socket.on('new-caption', captionData => {
    addCaption(captionData.translated, captionData.original, false);
});

socket.on('user-left', () => {
    showJoinUI('Other user has left');
    endCall();
});

// Initial Setup
joinBtn.addEventListener('click', joinCall);
endCallBtn.addEventListener('click', endCall);
switchCameraBtn.addEventListener('click', switchCamera);
window.addEventListener('load', startLocalMedia);
