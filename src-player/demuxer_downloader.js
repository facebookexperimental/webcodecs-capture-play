/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const WORKER_PREFIX = "[DOWNLOADER]";

importScripts('utils.js');
importScripts('../utils/packager_version.js');
importScripts('../packager/media_packager_header.js');

let workerState = StateEnum.Created;

// Default values
let rewindTimeMs = 0;
let startAtEpochMs = undefined;
let endAtEpochMs = undefined;

let quicStreamsExpirationTimeoutMs = 10000;

let videoJitterBufferMs = 200
let audioJitterBufferMs = 200


// WT server data
let urlHostPort = "";
let urlPath = "";

// WT object
let wtTransport = null;

// Default packager
let packagerVersion = PackagerVersion.V2Binary;

function reportStats() {
    sendMessageToMain(WORKER_PREFIX, "downloaderstats", { clkms: Date.now() });
}

// Main listener
self.addEventListener('message', async function (e) {
    if ((workerState === StateEnum.Created) || (workerState === StateEnum.Stopped)) {
        workerState = StateEnum.Instantiated;
    }

    if (workerState === StateEnum.Stopped) {
        sendMessageToMain(WORKER_PREFIX, "info", "downloader is stopped it does not accept messages");
        return;
    }

    var type = e.data.type;
    if (type == "stop") {
        workerState = StateEnum.Stopped;

        // Abort and wait for all inflight requests
        try {
            if (wtTransport != null) {
                await wtTransport.close();
                wtTransport = null;
            }
        } catch (err) {
            // Expected to finish some promises with abort error
            // The abort "errors" are already sent to main "thead" by sendMessageToMain inside the promise
        }

    } else if (type == "downloadersendini") {
        if (workerState !== StateEnum.Instantiated) {
            sendMessageToMain(WORKER_PREFIX, "error", "received ini message in wrong state. State: " + workerState);
            return;
        }
        if (!('urlHostPort' in e.data.downloaderConfig) || !('urlPath' in e.data.downloaderConfig)) {
            sendMessageToMain(WORKER_PREFIX, "error", "We need host, streamId to start playback");
            return
        }

        if ('rewindTimeMs' in e.data.downloaderConfig) {
            rewindTimeMs = e.data.downloaderConfig.rewindTimeMs;
        }
        if ('urlHostPort' in e.data.downloaderConfig) {
            urlHostPort = e.data.downloaderConfig.urlHostPort;
        }
        if ('urlPath' in e.data.downloaderConfig) {
            urlPath = e.data.downloaderConfig.urlPath;
        }
        if ('videoJitterBufferMs' in e.data.downloaderConfig) {
            videoJitterBufferMs = e.data.downloaderConfig.videoJitterBufferMs;
        }
        if ('audioJitterBufferMs' in e.data.downloaderConfig) {
            audioJitterBufferMs = e.data.downloaderConfig.audioJitterBufferMs;
        }
        if ('startAtEpochMs' in e.data.downloaderConfig) {
            startAtEpochMs = e.data.downloaderConfig.startAtEpochMs;
        }
        if ('endAtEpochMs' in e.data.downloaderConfig) {
            endAtEpochMs = e.data.downloaderConfig.endAtEpochMs;
        }
        if ('packagerVersion' in e.data.downloaderConfig) {
            if (e.data.downloaderConfig.packagerVersion == "v1") {
                packagerVersion = PackagerVersion.V1Json;
            }
        }

        await createWebTransportSession(urlHostPort + "/" + urlPath, rewindTimeMs, videoJitterBufferMs, audioJitterBufferMs, startAtEpochMs, endAtEpochMs, packagerVersion);

        sendMessageToMain(WORKER_PREFIX, "info", "Initialized");
        workerState = StateEnum.Running;

        startDownloadWebTransportChunks(quicStreamsExpirationTimeoutMs)
    }
});

function getUrlSegmentStr(bufferTargetMs, videoJitterBufferMs, audioJitterBufferMs, startAtEpochMs, endAtEpochMs, packagerVersion) {
    obj = {
        old_ms: `${bufferTargetMs}`,
        vj_ms: `${videoJitterBufferMs}`,
        aj_ms: `${audioJitterBufferMs}`
    };
    if (startAtEpochMs != undefined) {
        obj.sa = startAtEpochMs
    }
    if (endAtEpochMs != undefined) {
        obj.ea = endAtEpochMs
    }
    if (packagerVersion != undefined && packagerVersion.name != undefined) {
        obj.pk = packagerVersion.name
    }
    const params = new URLSearchParams(obj);
    return params.toString();
}

async function startDownloadWebTransportChunks(quicStreamsExpirationTimeoutMs) {
    if (workerState === StateEnum.Stopped) {
        return
    }
    if (wtTransport === null) {
        sendMessageToMain(WORKER_PREFIX, "error", "we can not start downloading data because WT is not initialized");
        return;
    }

    // Get stream
    const incomingStream = wtTransport.incomingUnidirectionalStreams;
    const readableStream = incomingStream.getReader();

    while (workerState != StateEnum.Stopped) {
        const stream = await readableStream.read();
        reportStats();
        if (stream.done) {
            sendMessageToMain(WORKER_PREFIX, "info", "exited from geting WT server readable streams");
            break;
        } else {
            await fetchWebTransportWithTimeout(stream.value, quicStreamsExpirationTimeoutMs);
        }
    }
}

async function createWebTransportSession(url, rewindTimeMs, videoJitterBufferMs, audioJitterBufferMs, startAtEpochMs, endAtEpochMs, packagerVersion) {
    if (wtTransport != null) {
        return;
    }
    wtTransport = new WebTransport(url + '?' + getUrlSegmentStr(rewindTimeMs, videoJitterBufferMs, audioJitterBufferMs, startAtEpochMs, endAtEpochMs, packagerVersion));
    await wtTransport.ready;

    wtTransport.closed
        .then(() => {
            sendMessageToMain(WORKER_PREFIX, "info", "WT closed transport session");
        })
        .catch(error => {
            sendMessageToMain(WORKER_PREFIX, "error", "WT error, closed transport. Err: " + error);
        });

    sendMessageToMain(WORKER_PREFIX, "info", "WT transport session established");
}

function fetchWebTransportWithTimeout(stream, timeoutMs) {
    return new Promise((resolve, reject) => {
        fetchWebTransportStream(stream, timeoutMs)
            .then(value => {
                return resolve(value);
            })
            .catch(err => {
                return reject(err);
            });
    });
}

async function fetchWebTransportStream(stream, timeoutMs) {
    const startTime = Date.now();

    try {
        const streamReader = stream.getReader();

        // Server will always send init segments 1st

        // Create client-initiated uni stream & reader
        receivedData = [];
        totalLength = 0;
        while (true) {
            const now = Date.now();
            if ((timeoutMs > 0) && (startTime + timeoutMs < now)) {
                throw "timeout " + timeoutMs + "ms, aborting stream. Start at: " + startTime + ", now: " + now;
            }
            data = await streamReader.read();
            if (data.value !== undefined) {
                receivedData.push(data.value);
                totalLength += data.value.byteLength;
            }
            if (data.done) {
                break;
            }
        }

        // Concatenate received data
        const chunkBytes = new Uint8Array(totalLength);
        let pos = 0;
        for (let element of receivedData) {
            chunkBytes.set(element, pos);
            pos += element.byteLength;
        }

        // Parse header
        // Careful here we lose 64 range
        const headerSize = Number(new DataView(chunkBytes.buffer).getBigUint64(0, false));
        if (headerSize + 8 > chunkBytes.byteLength) {
            throw "No enough bytes in the stream to parse header";
        }

        const packager = new MediaPackagerHeader();
        packager.SetDataFromBytes(chunkBytes.slice(8, headerSize + 8));
        const header = packager.GetData();

        if ((header.chunkType === undefined) || (header.mediaType === undefined)) {
            throw "Corrupted headers, we can NOT parse the data, headers: " + JSON.stringify(header);
        }

        // Create chunk from payload
        let chunk = null;
        if (header.chunkType === "init") {
            self.postMessage({ type: "init" + header.mediaType + "chunk", clkms: Date.now(), captureClkms: header.firstFrameClkms, data: chunkBytes.slice(headerSize + 8) });
        } else {
            if (header.mediaType === "audio") {
                chunk = new EncodedAudioChunk({
                    timestamp: header.timestamp,
                    type: header.chunkType,
                    data: chunkBytes.slice(headerSize + 8),
                    duration: header.duration
                });
            } else if (header.mediaType === "video") {
                chunk = new EncodedVideoChunk({
                    timestamp: header.timestamp,
                    type: header.chunkType,
                    data: chunkBytes.slice(headerSize + 8),
                    duration: header.duration
                });
            }
            self.postMessage({ type: header.mediaType + "chunk", clkms: Date.now(), captureClkms: header.firstFrameClkms, seqId: header.seqId, chunk: chunk });
        }

        const reqLatencyMs = Date.now() - startTime;
        if (reqLatencyMs > (header.duration / 1000)) {
            sendMessageToMain(WORKER_PREFIX, "warning", "response: 200, Latency(ms): " + reqLatencyMs + ", Frame dur(ms): " + header.duration / 1000 + ". mediaType: " + header.mediaType + ", seqId: " + header.seqId + ", ts: " + header.timestamp);
        } else {
            sendMessageToMain(WORKER_PREFIX, "debug", "response: 200, Latency(ms): " + reqLatencyMs + ", Frame dur(ms): " + header.duration / 1000 + ". mediaType: " + header.mediaType + ", seqId:" + header.seqId + ", ts: " + header.timestamp);
        }

        return null;
    }
    catch (error) {
        sendMessageToMain(WORKER_PREFIX, "dropped stream", { clkms: Date.now(), seqId: -1, msg: "Dropped stream because WT error" });
        sendMessageToMain(WORKER_PREFIX, "error", "WT request. Err: " + error);

        return error;
    }
}