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
let remotePeerId;
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
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        videoDevices = devices.filter(device => device.kind === 'videoinput');
        switchCameraBtn.disabled = videoDevices.length < 2;
    } catch(e) {
        console.error("Could not enumerate devices:", e);
    }
}

async function switchCamera() {
    if (videoDevices.length < 2) return;
    currentVideoDeviceIndex = (currentVideoDeviceIndex + 1) % videoDevices.length;
    const deviceId = videoDevices[currentVideoDeviceIndex].deviceId;

    const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
        audio: true, 
    });

    const newVideoTrack = newStream.getVideoTracks()[0];
    const sender = peerConnection?.getSenders().find(s => s.track.kind === 'video');
    if (sender) {
        sender.replaceTrack(newVideoTrack);
    }
    
    localStream.getVideoTracks()[0].stop();
    localStream.removeTrack(localStream.getVideoTracks()[0]);
    localStream.addTrack(newVideoTrack);
    localVideo.srcObject = localStream; 
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
        if (isRecognitionActive) { 
            setTimeout(() => recognition.start(), 100); 
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
        return data.responseData?.translatedText || text;
    } catch (e) {
        console.error("Translation failed:", e);
        return null;
    }
}

// --- WEBRTC & SOCKET.IO LOGIC ---
function joinCall() {
    if (!localStream) {
        alert("Cannot join call without access to camera and microphone.");
        return;
    }
    showStatus('Waiting for another user...');
    socket.emit('join-room', roomId);
}

function endCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    remoteVideo.srcObject = null;
    captionOverlay.innerHTML = '';
    stopRecognition();
    showJoinUI('Call Ended');
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = event => {
        if (event.streams && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
    };

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('signal', {
                target: remotePeerId,
                type: 'ice-candidate',
                data: event.candidate
            });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log("Connection State:", peerConnection.connectionState);
        switch(peerConnection.connectionState) {
            case "connected":
                hideOverlay();
                startRecognition();
                break;
            case "disconnected":
            case "closed":
            case "failed":
                endCall();
                showJoinUI('User has left');
                break;
        }
    };
}

// --- SOCKET EVENT LISTENERS ---
socket.on('language-assigned', lang => {
    myLanguage = lang;
    targetLanguage = myLanguage === 'en' ? 'ja' : 'en';
});

socket.on('room-full', () => showStatus('Room is full. Please try again later.'));

socket.on('user-joined', async ({ peerId }) => {
    remotePeerId = peerId;
    showStatus('User found. Connecting...');
    createPeerConnection();
    // The first user to join ('en') will create the offer
    if (myLanguage === 'en') {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', {
            target: remotePeerId,
            type: 'offer',
            data: offer
        });
    }
});

socket.on('signal', async ({ sender, type, data }) => {
    remotePeerId = sender; // Always update remotePeerId from the sender
    if (type === 'offer') {
        if (!peerConnection) createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('signal', {
            target: remotePeerId,
            type: 'answer',
            data: answer
        });
    } else if (type === 'answer') {
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
        }
    } else if (type === 'ice-candidate') {
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
    }
});

socket.on('new-caption', captionData => {
    addCaption(captionData.translated, captionData.original, false);
});

socket.on('user-left', () => {
    endCall();
});

// --- INITIAL SETUP ---
joinBtn.addEventListener('click', joinCall);
endCallBtn.addEventListener('click', () => {
    socket.disconnect(); // This triggers 'disconnect' on server
    endCall();
});
switchCameraBtn.addEventListener('click', switchCamera);
window.addEventListener('load', startLocalMedia);
