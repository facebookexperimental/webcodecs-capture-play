/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const WORKER_PREFIX = "[MUXER-SEND]";

importScripts('utils.js');
importScripts('../utils/packager_version.js');
importScripts('../packager/media_packager_header.js');

let chunks_delivered = 0;
let workerState = StateEnum.Created;

// Default values
let maxAgeChunkS = 120;

const maxFlightRequests = {
    'audio': 4,
    'video': 2,
}

let urlHostPort = "";
let urlPath = "";

// Inflight req abort signal
const abortController = new AbortController();
const inFlightRequests = {
    'video': {},
    'audio': {}
};

// WebTransport data
let wTtransport = null;

// Default packager
let packagerVersion = PackagerVersion.V2Binary;

// Packager efficiency
let efficiencyData = {
    audio: {
        totalPackagerBytesSent: 0,
        totalPayloadBytesSent: 0,
    },
    video: {
        totalPackagerBytesSent: 0,
        totalPayloadBytesSent: 0,
    }
}

// Debugging data 
/*let totalAudioSkippedDur = 0;
let totalVideoSkippedDur = 0;
let numAudioFramesDropped = 0;
let numVideoFramesDropped = 0;*/

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
        return;
    }

    if (type == "muxersendini") {
        if (workerState !== StateEnum.Instantiated) {
            sendMessageToMain(WORKER_PREFIX, "error", "received ini message in wrong state. State: " + workerState);
            return;
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
    if (mediaType == "audio") {
        sendChunkToTransport(chunkData, inFlightRequests['audio'], maxFlightRequests['audio'], packagerVersion);
    } else {
        sendChunkToTransport(chunkData, inFlightRequests['video'], maxFlightRequests['video'], packagerVersion);
    }

    // Report stats
    self.postMessage({ type: "sendstats", clkms: Date.now(), inFlightAudioReqNum: getInflightRequestsLength(inFlightRequests['audio']), inFlightVideoReqNum: getInflightRequestsLength(inFlightRequests['video']), efficiencyData: efficiencyData });

    return;
});

function sendChunkToTransport(chunkData, inFlightRequests, maxFlightRequests, packagerVersion) {
    if (chunkData == null) {
        return;
    }
    if (getInflightRequestsLength(inFlightRequests) >= maxFlightRequests) {
        sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), seqId: chunkData.seqId, mediaType: chunkData.mediaType, ts: chunkData.timestamp, msg: "Dropped chunk because too many inflight requests" });
        return;
    }
    return createRequests(chunkData, packagerVersion);
}

function getInflightRequestsLength(inFlightRequestsType) {
    return Object.keys(inFlightRequestsType).length;
}

function getAllInflightRequestsArray() {
    const arrAudio = Object.values(inFlightRequests['audio']);
    const arrVideo = Object.values(inFlightRequests['video']);

    return arrAudio.concat(arrVideo)
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
    try {
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

        if (mediaType == "video") {
            efficiencyData.video.totalPackagerBytesSent += pkgInfo.packagerBytes;
            efficiencyData.video.totalPayloadBytesSent += pkgInfo.payloadBytes;
        } else if (mediaType == "audio") {
            efficiencyData.audio.totalPackagerBytesSent += pkgInfo.packagerBytes;
            efficiencyData.audio.totalPayloadBytesSent += pkgInfo.payloadBytes;
        }

        p
            //.then(x => new Promise(resolve => setTimeout(() => resolve(x), 200))) // Debug
            .then(val => {
                sendMessageToMain(WORKER_PREFIX, "debug", "sent: 200. For " + mediaType + "-" + seqId + "-" + timestamp + "-" + duration + "-" + chunkType + "-" + firstFrameClkms);
                removeFromInflight(mediaType, pId);
            })
            .catch(err => {
                sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), ts: timestamp, msg: "Dropped " + mediaType + "chunk because sending chunk error" });
                sendMessageToMain(WORKER_PREFIX, "error", "request: " + mediaType + "-" + seqId + ". Err: " + err.message);

                removeFromInflight(mediaType, pId);
            });
        return p;
    } catch (ex) {
        sendMessageToMain(WORKER_PREFIX, "error", "request: " + mediaType + "-" + seqId + ". Err: " + ex.message);
    }
    return null;
}
