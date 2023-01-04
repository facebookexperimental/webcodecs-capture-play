const WORKER_PREFIX = "[MUXER-SEND]";

const VIDEO_PENALTY_SENT_FRAMES = 5;

importScripts('utils.js');

let chunks_delivered = 0;
let workerState = StateEnum.Created;

// Default values
let audioMaxMaxQueueSizeMs = 300;
let videoMaxMaxQueueSizeMs = 150;
let maxAgeChunkS = 120;
// Video penalty
// In case of congestion make sure we can send N audios until we can send video again
let videoPenaltyAudioSentFrames = 0;

let videoNextNeedsKey = false;
 
const maxFlightRequests = {
    'audio': 4,
    'video': 2,
}

let urlHostPort = "http://localhost:9094";
let urlPath = "streamid";

// Sending queues
const queue = {
    'video': [],
    'audio': []
}

// Inflight req abort signal
const abortController = new AbortController();
const inFlightRequests = {
    'video': {},
    'audio': {}
};

// Checks if audio and / or video are present
let isAudioPresent = false;
let isVideoPresent = false;

function getQueueStats(queue) {
    let oldestTs = -1;
    let newestTs = -1;
    let oldestSeqId = -1;
    let newestSeqId = -1;
    if (queue.length > 0) {
        oldestTs = queue[0].chunk.timestamp;
        oldestSeqId = queue[0].seqId;
        if (queue.length > 1) {
            newestTs = queue[queue.length - 1].chunk.timestamp;
            newestSeqId = queue[queue.length - 1].seqId;
        }
    }
    return {
        oldestTs: oldestTs,
        newestTs: newestTs,
        oldestSeqId: oldestSeqId,
        newestSeqId: newestSeqId,
        lengthMs: getQueueLengthMs(queue),
        numElements: queue.length,
    }
}

function getQueueLengthMs(queue) {
    let r = 0;

    if (queue.length > 1) {
        const newest = queue[queue.length-1];
        const oldest = queue[0];

        r = (newest.chunk.timestamp - oldest.chunk.timestamp) / 1000
    }
    return r;
}

self.addEventListener('message', async function(e) {
    if (workerState === StateEnum.Created) {
        workerState = StateEnum.Instantiated;
    }

    if (workerState === StateEnum.Stopped) {
        sendMessageToMain(WORKER_PREFIX, "info", "Muxer-send is stopped it does not accept messages");
        return;
    }

    var type = e.data.type;
    if (type == "stop") {
        workerState = StateEnum.Stopped;

        // Abort and wait for all inflight requests
        try {
            abortController.abort();
            await Promise.all(getAllInflightRequestsArray()); 
        } catch (err) {
            // Expected to finish some promises with abort error
            // The abort "errors" are already sent to main "thead" by sendMessageToMain inside the promise
        }

        // Remove all elements from sending queues
        while (queue['audio'].length > 0) {
            queue['audio'].shift();
        }
        while (queue['video'].length > 0) {
            queue['video'].shift();
        }
        return;
    }

    if (type == "muxersendini") {
        if (workerState !== StateEnum.Instantiated) {
            sendMessageToMain(WORKER_PREFIX, "error", "received ini message in wrong state. State: " + workerState);
            return;
        }

        if ('audioMaxMaxQueueSizeMs' in e.data.muxerSenderConfig) {
            audioMaxMaxQueueSizeMs = e.data.muxerSenderConfig.audioMaxMaxQueueSizeMs;
        }
        if ('videoMaxMaxQueueSizeMs' in e.data.muxerSenderConfig) {
            videoMaxMaxQueueSizeMs = e.data.muxerSenderConfig.videoMaxMaxQueueSizeMs;
        }
        if ('maxInFlightAudioRequests' in e.data.muxerSenderConfig) {
            maxFlightRequests['audio'] = e.data.muxerSenderConfig.maxInFlightAudioRequests;
        }
        if ('maxInFlightVideoRequests' in e.data.muxerSenderConfig) {
            maxFlightRequests['video'] = e.data.muxerSenderConfig.maxInFlightVideoRequests;
        }
        if ('urlHostPort' in e.data.muxerSenderConfig) {
            urlHostPort = e.data.muxerSenderConfig.urlHostPort;
        }
        if ('urlPath' in e.data.muxerSenderConfig) {
            urlPath = e.data.muxerSenderConfig.urlPath;
        }
        if ('maxAgeChunkS' in e.data.muxerSenderConfig) {
            maxAgeChunkS = e.data.muxerSenderConfig.maxAgeChunkS;
        }
        sendMessageToMain(WORKER_PREFIX, "info", "Initialized");

        workerState = StateEnum.Running;
        return;
    }

    if ((type != "vchunk") && (type != "achunk")) {
        sendMessageToMain(WORKER_PREFIX, "error", "Invalid message received");
        return;
    }
    
    let mediaType = "unknown";
    if (type === "vchunk") {
        mediaType = "video";
    } else if (type === "achunk") {
        mediaType = "audio";
    }
    
    const chunkData = {mediaType: mediaType, firstFrameClkms: e.data.firstFrameClkms, compesatedTs: e.data.compesatedTs, estimatedDuration: e.data.estimatedDuration, seqId: e.data.seqId, maxAgeChunkS: maxAgeChunkS, chunk: e.data.chunk, metadata: e.data.metadata};
    if (type === "vchunk") {
        isVideoPresent = true;
        if (getQueueLengthMs(queue[mediaType]) >= videoMaxMaxQueueSizeMs) {
            // We drop all the queue we want low latency over quality (circular queue)
            while (queue[mediaType].length > 0) {
                vChunkDataDropped = queue[mediaType].shift();
                sendMessageToMain(WORKER_PREFIX, "dropped", {clkms: Date.now(), seqId: vChunkDataDropped.seqId, mediaType: vChunkDataDropped.mediaType, ts: vChunkDataDropped.chunk.timestamp, msg: "Dropped video chunk (all queue)"});
            }
            videoNextNeedsKey = true; // Since we do not know the relation between delta frames we wait for I frame when we drop just 1 video frame
            if (isAudioPresent) {
                videoPenaltyAudioSentFrames = VIDEO_PENALTY_SENT_FRAMES;
            }
            // TODO: JOC Improvement tell encoder to insert a keyframe
        } else {
            if (videoPenaltyAudioSentFrames > 0) {
                sendMessageToMain(WORKER_PREFIX, "dropped", {clkms: Date.now(), seqId: chunkData.seqId, mediaType: chunkData.mediaType, ts: chunkData.chunk.timestamp, msg: "Dropped video chunk (penalty)"});
            } else if (videoNextNeedsKey && chunkData.chunk.type != "key") {
                sendMessageToMain(WORKER_PREFIX, "dropped", {clkms: Date.now(), seqId: chunkData.seqId, mediaType: chunkData.mediaType, ts: chunkData.chunk.timestamp, msg: "Dropped video chunk (waiting key)"});
            } else {
                queue[mediaType].push(chunkData);
                videoNextNeedsKey = false;
            }
        }
    }
    else if (type === "achunk") {
        isAudioPresent = true;
        if (getQueueLengthMs(queue[mediaType]) >= audioMaxMaxQueueSizeMs) {
            // We drop all the queue we want low latency over quality and minimize glitches
            while (queue[mediaType].length > 0) {
                aChunkDataDropped = queue[mediaType].shift();
                sendMessageToMain(WORKER_PREFIX, "dropped", {clkms: Date.now(), seqId: aChunkDataDropped.seqId, mediaType: aChunkDataDropped.mediaType, ts: aChunkDataDropped.chunk.timestamp, msg: "Dropped audio chunk (all queue)"});
            }            
        } else {
            if (videoPenaltyAudioSentFrames > 0) {
                videoPenaltyAudioSentFrames--;
            }
            queue[mediaType].push(chunkData);
        }
    }

    sendData();

    // Report stats
    self.postMessage({type: "sendstats", clkms: Date.now(), inFlightAudioReqNum: getInflightRequestsLength(inFlightRequests['audio']), inFlightVideoReqNum: getInflightRequestsLength(inFlightRequests['video']), audioQueueStats: getQueueStats(queue['audio']), videoQueueStats: getQueueStats(queue['video'])});

    return;
});

function getInflightRequestsLength(inFlightRequestsType) {
    return Object.keys(inFlightRequestsType).length;
}

function getAllInflightRequestsArray() {
    const arrAudio = Object.values(inFlightRequests['audio']);
    const arrVideo = Object.values(inFlightRequests['video']);
    
    return arrAudio.concat(arrVideo)
}

function sendData() {
    sendDataFromQueue(queue['audio'], inFlightRequests['audio'], maxFlightRequests['audio']);
    sendDataFromQueue(queue['video'], inFlightRequests['video'], maxFlightRequests['video']);
}

function sendDataFromQueue(queue, inFlightRequests, maxFlightRequests) {
    const ret = [];
    while ((queue.length > 0) && (getInflightRequestsLength(inFlightRequests) < maxFlightRequests)) {
        const chunkData = queue.shift();
        if (chunkData !== null) {
            const requests = createRequests(chunkData);
            requests.forEach(p => {
                ret.push(p);
            });
        }
    }
    return ret;
}

function createRequests(chunkData) {
    const ret = [];
    const mediaType = chunkData.mediaType;
    const seqId = chunkData.seqId;
    const maxAgeChunkS = chunkData.maxAgeChunkS;
    const chunk = chunkData.chunk;
    const metadata = chunkData.metadata;
    const firstFrameClkms = chunkData.firstFrameClkms;
    const compesatedTs = chunkData.compesatedTs;
    const estimatedDuration = (chunkData.estimatedDuration === undefined) ? chunk.duration : chunkData.estimatedDuration;

    // Decoder needs to be configured (or reconfigured) with new parameters
    // when metadata has a new decoderConfig.
    // Usually it happens in the beginning or when the encoder has a new
    // codec specific binary configuration. (VideoDecoderConfig.description).
    if (metadata != undefined) {
        const urlVideoInit = `${urlHostPort}/${urlPath}/${mediaType}/init`;
        pIni = createRequestPromise(urlVideoInit, firstFrameClkms, mediaType, "init", compesatedTs, estimatedDuration, -1, Number.MAX_SAFE_INTEGER, metadata);
        ret.push(pIni);
    }
    
    // actual bytes of encoded data
    const chunkDataBuffer = new Uint8Array(chunk.byteLength);
    chunk.copyTo(chunkDataBuffer);
    
    const urlVideoChunk = `${urlHostPort}/${urlPath}/${mediaType}/${seqId}`;
    const pChunk = createRequestPromise(urlVideoChunk, firstFrameClkms, mediaType, chunk.type, compesatedTs, estimatedDuration, seqId, maxAgeChunkS, chunkDataBuffer);
    ret.push(pChunk);

    return ret;
}

function addToInflight(mediaType, p) {
    if (p.id in inFlightRequests[mediaType]) {
        sendMessageToMain(WORKER_PREFIX, "error", "id already exists in inflight, this should never happen");
    } else {
        inFlightRequests[mediaType][p.id] = p;
    }
}
    
function removeFromInflight(mediaType, id) {
    if (id in inFlightRequests[mediaType]) {
        delete inFlightRequests[mediaType][id];
    }
}

function createRequestPromise(url, firstFrameClkms, mediaType, chunkType, timestamp, duration, seqId, maxAgeChunkS, dataBytes) {
    // Generate a unique id in the stream
    const pId = btoa(url + "-" + mediaType + "-" + timestamp + "-" + seqId + "-"+ Math.floor(Math.random * 100000));

    const headers = new Headers();
    headers.append('Content-Type', 'application/octet-stream');
    headers.append('Cache-Control', `max-age=${maxAgeChunkS}`);

    headers.append('Joc-Media-Type', mediaType);
    headers.append('Joc-Timestamp', timestamp);
    headers.append('Joc-Duration', duration);
    headers.append('Joc-Chunk-Type', chunkType);
    headers.append('Joc-Seq-Id', seqId);
    headers.append('Joc-First-Frame-Clk', firstFrameClkms);
    headers.append('Joc-Uniq-Id', pId);

    const options = {
        method: 'POST',
        headers: headers,
        body: dataBytes,
        signal: abortController.signal,
    }

    const p = fetch(url, options);
    p.id = pId;

    addToInflight(mediaType, p);

    p
    //.then(x => new Promise(resolve => setTimeout(() => resolve(x), 200))) // Debug
    .then(resp => {
        if (resp.ok) {
            sendMessageToMain(WORKER_PREFIX, "debug", "sent: " + resp.status + ". For " + mediaType + "-" + seqId + "-" + timestamp);
        } else {
            sendMessageToMain(WORKER_PREFIX, "dropped", {clkms: Date.now(), ts: timestamp, msg: "Dropped " + mediaType + "chunk because server error response"});
            sendMessageToMain(WORKER_PREFIX, "error", "request response error: " + resp.status + ". For " + mediaType + "-" + seqId);
        }
        removeFromInflight(mediaType, pId);

        sendData();
    })
    .catch(err => {
        sendMessageToMain(WORKER_PREFIX, "dropped", {clkms: Date.now(), ts: timestamp, msg: "Dropped " + mediaType + "chunk because sending chunk error"});
        sendMessageToMain(WORKER_PREFIX, "error", "request: " + mediaType + "-" + seqId + ". Err: " + err.message);    

        removeFromInflight(mediaType, pId);

        sendData();
    });
    return p;
}
