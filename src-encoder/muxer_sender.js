/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const WORKER_PREFIX = "[MUXER-SEND]";

const VIDEO_PENALTY_SENT_FRAMES = 5;

importScripts('utils.js');
importScripts('../utils/packager_version.js');
importScripts('../packager/media_packager_header.js');

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

let urlHostPort = "";
let urlPath = "";

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

// WebTransport data
let wTtransport = null;

// Default packager
let packagerVersion = PackagerVersion.V2Binary;

// Packager efficiency
let efficiencyAvg = 0;
let totalPackagerBytesSent = 0;
let totalPayloadBytesSent = 0;

// Debugging data 
let totalAudioSkippedDur = 0;
let totalVideoSkippedDur = 0;
let numAudioFramesDropped = 0;
let numVideoFramesDropped = 0;

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
        const newest = queue[queue.length - 1];
        const oldest = queue[0];

        r = (newest.chunk.timestamp - oldest.chunk.timestamp) / 1000
    }
    return r;
}

self.addEventListener('message', async function (e) {
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

            if (wTtransport != null) {
                await wTtransport.close();
                wTtransport = null;
            }
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
        if ('packagerVersion' in e.data.muxerSenderConfig) {
            if (e.data.muxerSenderConfig.packagerVersion == "v1") {
                packagerVersion = PackagerVersion.V1Json;
            }
        }

        await createWebTransportSession(urlHostPort + "/" + urlPath);
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

    if ((type != "vchunk") && (type != "achunk")) {
        sendMessageToMain(WORKER_PREFIX, "error", "Invalid message received");
        return;
    }

    if (workerState !== StateEnum.Running) {
        sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), seqId: e.data.seqId, mediaType: mediaType, ts: e.data.chunk.timestamp, msg: "Dropped chunk because transport is NOT open yet" });
        return;
    }

    const chunkData = { mediaType: mediaType, firstFrameClkms: e.data.firstFrameClkms, compesatedTs: e.data.compesatedTs, estimatedDuration: e.data.estimatedDuration, seqId: e.data.seqId, maxAgeChunkS: maxAgeChunkS, chunk: e.data.chunk, metadata: e.data.metadata };
    if (type === "vchunk") {
        isVideoPresent = true;
        if (getQueueLengthMs(queue[mediaType]) >= videoMaxMaxQueueSizeMs) {
            // We drop all the queue we want low latency over quality (circular queue)
            while (queue[mediaType].length > 0) {
                vChunkDataDropped = queue[mediaType].shift();
                sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), seqId: vChunkDataDropped.seqId, mediaType: vChunkDataDropped.mediaType, ts: vChunkDataDropped.chunk.timestamp, msg: "Dropped video chunk (all queue)" });
            }
            videoNextNeedsKey = true; // Since we do not know the relation between delta frames we wait for I frame when we drop just 1 video frame
            if (isAudioPresent) {
                videoPenaltyAudioSentFrames = VIDEO_PENALTY_SENT_FRAMES;
            }
            // TODO: JOC Improvement tell encoder to insert a keyframe
        } else {
            if (videoPenaltyAudioSentFrames > 0) {
                sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), seqId: chunkData.seqId, mediaType: chunkData.mediaType, ts: chunkData.chunk.timestamp, msg: "Dropped video chunk (penalty)" });
            } else if (videoNextNeedsKey && chunkData.chunk.type != "key") {
                sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), seqId: chunkData.seqId, mediaType: chunkData.mediaType, ts: chunkData.chunk.timestamp, msg: "Dropped video chunk (waiting key)" });
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
                sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), seqId: aChunkDataDropped.seqId, mediaType: aChunkDataDropped.mediaType, ts: aChunkDataDropped.chunk.timestamp, msg: "Dropped audio chunk (all queue)" });
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
    self.postMessage({ type: "sendstats", clkms: Date.now(), inFlightAudioReqNum: getInflightRequestsLength(inFlightRequests['audio']), inFlightVideoReqNum: getInflightRequestsLength(inFlightRequests['video']), audioQueueStats: getQueueStats(queue['audio']), videoQueueStats: getQueueStats(queue['video']), efficiency: efficiencyAvg });

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
    sendDataFromQueue(queue['audio'], inFlightRequests['audio'], maxFlightRequests['audio'], packagerVersion);
    sendDataFromQueue(queue['video'], inFlightRequests['video'], maxFlightRequests['video'], packagerVersion);
}

function sendDataFromQueue(queue, inFlightRequests, maxFlightRequests, packagerVersion) {
    const ret = [];
    while ((queue.length > 0) && (getInflightRequestsLength(inFlightRequests) < maxFlightRequests)) {
        const chunkData = queue.shift();
        if (chunkData !== null) {
            const requests = createRequests(chunkData, packagerVersion);
            requests.forEach(p => {
                ret.push(p);
            });
        }
    }
    return ret;
}

function createRequests(chunkData, packagerVersion) {
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
        let pIni = null;
        pIni = createWebTransportRequestPromise(firstFrameClkms, mediaType, "init", compesatedTs, estimatedDuration, -1, Number.MAX_SAFE_INTEGER, metadata, packagerVersion);
        ret.push(pIni);
    }

    // actual bytes of encoded data
    const chunkDataBuffer = new Uint8Array(chunk.byteLength);
    chunk.copyTo(chunkDataBuffer);

    let pChunk = null;
    pChunk = createWebTransportRequestPromise(firstFrameClkms, mediaType, chunk.type, compesatedTs, estimatedDuration, seqId, maxAgeChunkS, chunkDataBuffer, packagerVersion);
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

// WebTransport

async function createWebTransportSession(url) {
    if (wTtransport != null) {
        return;
    }
    wTtransport = new WebTransport(url);
    await wTtransport.ready;

    wTtransport.closed
        .then(() => {
            sendMessageToMain(WORKER_PREFIX, "info", "WT closed transport session");
        })
        .catch(error => {
            sendMessageToMain(WORKER_PREFIX, "error", "WT error, closed transport. Err: " + error);
        });
}

function convertToUint64BE(n) {
    const b = new Uint8Array(8);
    let src = n;
    for (let n = 7; n >= 0; n--) {
        b[n] = src & 0xFF;
        src = src >> 8;
    }
    return b;
}

async function createWebTransportRequestPromise(firstFrameClkms, mediaType, chunkType, timestamp, duration, seqId, maxAgeChunkS, dataBytes, packagerVersion) {
    if (wTtransport === null) {
        sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), ts: timestamp, msg: "Dropped " + mediaType + "chunk because server error response" });
        sendMessageToMain(WORKER_PREFIX, "error", "request not send because transport is NOT open. For " + mediaType + "-" + seqId);
        return;
    }

    // Comment this. Useful to test A.V sync functionality in server & player

    //if (mediaType === "audio" && seqId > 0 && seqId%20 === 0) {
    /*if (mediaType === "audio" && seqId > 0 && seqId > 100 && seqId < 120) {
        totalAudioSkippedDur += duration;
        numAudioFramesDropped++;
        console.log("JOC dropped audio seqId: " + seqId + ", totalAudioSkippedDur: " + totalAudioSkippedDur + ", numAudioFramesDropped: " + numAudioFramesDropped);
        return;
    }/*
    if (mediaType === "video" && seqId > 0 && seqId%100 === 0) {
        totalVideoSkippedDur += duration;
        numVideoFramesDropped++;
        console.log("JOC dropped video seqId: " + seqId + ", totalVideoSkippedDur: " + totalVideoSkippedDur + ", numVideoFramesDropped: " + numVideoFramesDropped);
        return;
    }*/

    // Generate a unique id in the stream
    const pId = btoa(`${mediaType}-${seqId}-${timestamp}- ${Math.floor(Math.random * 100000)}`);
    const packager = new MediaPackagerHeader();
    packager.SetData(maxAgeChunkS, mediaType, timestamp, duration, chunkType, seqId, firstFrameClkms, pId, dataBytes);

    // Create client-initiated uni stream & writer
    const uniStream = await wTtransport.createUnidirectionalStream();
    const uniWriter = uniStream.getWriter();
    await uniWriter.ready;

    uniWriter.write(packager.ToBytes(packagerVersion));

    const p = uniWriter.close();
    p.id = pId;

    addToInflight(mediaType, p);

    // Calculate efficiency avg accumulatively
    const pkgInfo = packager.GetPackagerInfo();

    totalPackagerBytesSent += pkgInfo.packagerBytes;
    totalPayloadBytesSent += pkgInfo.payloadBytes;
    
    efficiencyAvg = totalPayloadBytesSent / (totalPackagerBytesSent + totalPayloadBytesSent);

    p
        //.then(x => new Promise(resolve => setTimeout(() => resolve(x), 200))) // Debug
        .then(val => {
            sendMessageToMain(WORKER_PREFIX, "debug", "sent: 200. For " + mediaType + "-" + seqId + "-" + timestamp + "-" + duration + "-" + chunkType + "-" + firstFrameClkms);
            removeFromInflight(mediaType, pId);

            sendData();
        })
        .catch(err => {
            sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), ts: timestamp, msg: "Dropped " + mediaType + "chunk because sending chunk error" });
            sendMessageToMain(WORKER_PREFIX, "error", "request: " + mediaType + "-" + seqId + ". Err: " + err.message);

            removeFromInflight(mediaType, pId);

            sendData();
        });
    return p;
}
