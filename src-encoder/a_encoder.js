const WORKER_PREFIX = "[AUDIO-ENC]";

importScripts('utils.js');

let frame_delivered_counter = 0;
let chunk_delivered_counter = 0;
let workerState = StateEnum.Created;

// Default values
let encoderMaxQueueSize = 5;

// Encoder
const initAudioEncoder = {
    output: handleChunk,
    error: (e) => {
        if (workerState === StateEnum.Created) {
            console.error(e.message);
        } else {
            sendMessageToMain(WORKER_PREFIX, "error", e.message);
        }
    }
};

let aEncoder = null;

function handleChunk(chunk, metadata) {
    const msg = {type: "achunk", seqId: chunk_delivered_counter++, chunk: chunk, metadata: serializeMetadata(metadata)};
    sendMessageToMain(WORKER_PREFIX, "info", "Chunk created. sId: " + msg.seqId + ", Timestamp: " + chunk.timestamp + ", dur: " + chunk.duration + ", type: " + chunk.type + ", size: " + chunk.byteLength);

    self.postMessage(msg);
}

self.addEventListener('message', async function(e) {
    if (workerState === StateEnum.Created) {
        workerState = StateEnum.Instantiated;
    }

    if (workerState === StateEnum.Stopped) {
        sendMessageToMain(WORKER_PREFIX, "info", "Encoder is stopped it does not accept messages");
        return;
    }

    var type = e.data.type;
    if (type == "stop") {
        workerState = StateEnum.Stopped;
        // Make sure all requests has been processed
        await aEncoder.flush();
        
        aEncoder.close();
        return;
    }
    if (type == "aencoderini") {
        const encoderConfig = e.data.encoderConfig;

        aEncoder = new AudioEncoder(initAudioEncoder);

        aEncoder.configure(encoderConfig);
        if ('encoderMaxQueueSize' in e.data) {
            encoderMaxQueueSize = e.data.encoderMaxQueueSize;
        }        
        sendMessageToMain(WORKER_PREFIX, "info", "Encoder initialized");
        return;
    }
    if (type != "aframe") {
        sendMessageToMain(WORKER_PREFIX, "error", "Invalid message received");
        return;
    }

    const aFrame = e.data.aframe;

    if (aEncoder.encodeQueueSize > encoderMaxQueueSize) {
        // Too many frames in the encoder, encoder is overwhelmed let's drop this frame.
        sendMessageToMain(WORKER_PREFIX, "dropped", {clkms: Date.now(), ts: aFrame.timestamp, msg: "Dropped encoding audio frame"});
        aFrame.close();
    } else {
        sendMessageToMain(WORKER_PREFIX, "debug", "Send to encode frame ts: " + aFrame.timestamp + ". Counter: " + frame_delivered_counter++);

        aEncoder.encode(aFrame);
        aFrame.close();
    }

    return;
});