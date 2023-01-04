const WORKER_PREFIX = "[VIDEO-ENC]";

importScripts('utils.js');

let frame_delivered_counter = 0;
let chunk_delivered_counter = 0;

let workerState = StateEnum.Created;

// Default values
let encoderMaxQueueSize = 5;
let keyframeEvery = 60;
let insertNextKeyframe = false;

// Encoder
const initVideoEncoder = {
    output: handleChunk,
    error: (e) => {
        if (workerState === StateEnum.Created) {
            console.error(e.message);
        } else {
            sendMessageToMain(WORKER_PREFIX, "error", e.message);
        }
    }
};

let vEncoder = null;

function handleChunk(chunk, metadata) {
    const msg = {type: "vchunk", seqId: chunk_delivered_counter++, chunk: chunk, metadata: serializeMetadata(metadata)};
    
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
        await vEncoder.flush();

        vEncoder.close();
        workerState = StateEnum.Stopped;
        return;
    }
    if (type == "vencoderini") {
        const encoderConfig = e.data.encoderConfig;

        vEncoder = new VideoEncoder(initVideoEncoder);

        vEncoder.configure(encoderConfig);
        if ('encoderMaxQueueSize' in e.data) {
            encoderMaxQueueSize = e.data.encoderMaxQueueSize;
        }
        if ('keyframeEvery' in e.data) {
            keyframeEvery = e.data.keyframeEvery;
        }
        sendMessageToMain(WORKER_PREFIX, "info", "Encoder initialized");

        workerState = StateEnum.Running;
        return;
    }
    if (type != "vframe") {
        sendMessageToMain(WORKER_PREFIX, "error", "Invalid message received");
        return;
    }

    const vFrame = e.data.vframe;

    if (vEncoder.encodeQueueSize > encoderMaxQueueSize) {
        // Too many frames in the encoder queue, encoder is overwhelmed let's not add this frame
        sendMessageToMain(WORKER_PREFIX, "dropped", {clkms: Date.now(), ts: vFrame.timestamp, msg: "Dropped encoding video frame"});
        vFrame.close();
        // Insert a keyframe after dropping
        insertNextKeyframe = true;
    } else {
        const frame_num = frame_delivered_counter++;
        const insert_keyframe = (frame_num % keyframeEvery) == 0 || (insertNextKeyframe == true);
        vEncoder.encode(vFrame, { keyFrame: insert_keyframe });
        vFrame.close();
        sendMessageToMain(WORKER_PREFIX, "debug", "Encoded frame: " + frame_num + ", key: " + insert_keyframe);
        insertNextKeyframe = false;
        frame_delivered_counter++;
    }

    return;
});