/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const WORKER_PREFIX = "[RAW-SENDER]";

importScripts('utils.js');
importScripts('muxer.js');
importScripts('../utils/packager_version.js');

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
        totalPackagerBytes: 0,
        totalPayloadBytes: 0,
    },
    video: {
        totalPackagerBytes: 0,
        totalPayloadBytes: 0,
    }
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
    const packets = chunkDataToPackager(chunkData)
    packets.forEach(packet => {
        const p = createSendPromise(packet, packagerVersion);
        if (p != null) {
            ret.push(p);
        }

    });
    return ret;
}

async function createSendPromise(packet, packagerVersion) {
    if (wTtransport === null) {
        sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), ts: timestamp, msg: "Dropped " + mediaType + "chunk because server error response" });
        sendMessageToMain(WORKER_PREFIX, "error", "request not send because transport is NOT open. For " + mediaType + "-" + seqId);
        return null;
    }

    let uniWriter = null;
    const p = wTtransport.createUnidirectionalStream()
        .then(function (uniStream) {
            uniWriter = uniStream.getWriter();
            return uniWriter.ready;
        })
        .then(function () {
            const buf = packet.ToBytes(packagerVersion);

            // Calculate efficiency avg accumulatively
            const pkgInfo = packet.GetPackagerInfo();

            if (packet.GetData().mediaType == "video") {
                efficiencyData.video.totalPackagerBytes += pkgInfo.packagerBytes;
                efficiencyData.video.totalPayloadBytes += pkgInfo.payloadBytes;
            } else if (packet.GetData().mediaType == "audio") {
                efficiencyData.audio.totalPackagerBytes += pkgInfo.packagerBytes;
                efficiencyData.audio.totalPayloadBytes += pkgInfo.payloadBytes;
            }

            return uniWriter.write(buf);
        })
        .then(function () {
            return uniWriter.ready;
        })
        .then(function () {
            return uniWriter.close();
        })
        .then(function () {
            // OK
            sendMessageToMain(WORKER_PREFIX, "debug", "sent: 200. For " + packet.GetDataStr());
        }).catch(function (e) {
            // ERR
            sendMessageToMain(WORKER_PREFIX, "dropped", { clkms: Date.now(), ts: packet.GetData().timestamp, msg: `Dropped chunk because sending chunk error, data: ${packet.GetDataStr()}` });
            sendMessageToMain(WORKER_PREFIX, "error", "request: " + packet.GetDataStr() + ". Err: " + e.message);
        })
        .finally(() => {
            removeFromInflight(packet.GetData().mediaType, packet.GetData().pId);
        });
    
    p.id = packet.GetData().pId
    addToInflight(packet.GetData().mediaType, p);

    return p;
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
