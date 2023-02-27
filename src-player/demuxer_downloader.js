/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const WORKER_PREFIX = "[DOWNLOADER]";

importScripts('utils.js');

let workerState = StateEnum.Created;

// Default values
let rewindTimeMs = 0;
let startAtEpochMs = undefined;
let endAtEpochMs = undefined;

let quicStreamsExpirationTimeoutMs = 7000;

let videoJitterBufferMs = 200
let audioJitterBufferMs = 200


// WT server data
let urlHostPort = "";
let urlPath = "";

// WT object
let wtTransport = null;
let quicStreamsInFlight = 0;

function reportStats() {
    sendMessageToMain(WORKER_PREFIX, "downloaderstats", { clkms: Date.now(), quicStreamsInFlight: quicStreamsInFlight});
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
            quicStreamsInFlight = 0;
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
        
        await createWebTransportSession(urlHostPort + "/" + urlPath, rewindTimeMs, videoJitterBufferMs, audioJitterBufferMs, startAtEpochMs, endAtEpochMs);

        sendMessageToMain(WORKER_PREFIX, "info", "Initialized");
        workerState = StateEnum.Running;

        startDownloadWebTransportChunks(quicStreamsExpirationTimeoutMs)
    }
});

function getUrlSegmentStr(bufferTargetMs, videoJitterBufferMs, audioJitterBufferMs, startAtEpochMs, endAtEpochMs) {
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

async function createWebTransportSession(url, rewindTimeMs, videoJitterBufferMs, audioJitterBufferMs, startAtEpochMs, endAtEpochMs) {
    if (wtTransport != null) {
        return;
    }
    wtTransport = new WebTransport(url + '?' + getUrlSegmentStr(rewindTimeMs, videoJitterBufferMs, audioJitterBufferMs, startAtEpochMs, endAtEpochMs));
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
                return resolve(err);
            });
    });
}

async function fetchWebTransportStream(stream, timeoutMs) {
    const startTime = Date.now();
    quicStreamsInFlight++;

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
            throw "No enought bytes in the stream to parse header";
        }
        const headerJson = new TextDecoder().decode(chunkBytes.slice(8, headerSize + 8))
        const header = JSON.parse(headerJson);

        // Get header data
        let seqId = -1;
        if (header['Joc-Seq-Id'] !== null) {
            seqId = header['Joc-Seq-Id'];
        }
        const timestamp = parseInt(header['Joc-Timestamp']);
        const type = header['Joc-Chunk-Type']; // Init, IDR, delta
        const mediaType = header['Joc-Media-Type']; // audio, video
        const duration = header['Joc-Duration'];
        const captureClkms = header['Joc-First-Frame-Clk'];

        if ((type === undefined) || (mediaType === undefined)) {
            throw "Corrupted headers, we not NOT parse the data, headers: " + JSON.stringify(header);
        }

        // Create chunk from payload
        let chunk = null;
        if (type === "init") {
            self.postMessage({ type: "init" + mediaType + "chunk", clkms: Date.now(), captureClkms: captureClkms, data: chunkBytes.slice(headerSize + 8) });
        } else {
            if (mediaType === "audio") {
                chunk = new EncodedAudioChunk({
                    timestamp: timestamp,
                    type: type,
                    data: chunkBytes.slice(headerSize + 8),
                    duration: duration
                });
            } else if (mediaType === "video") {
                chunk = new EncodedVideoChunk({
                    timestamp: timestamp,
                    type: type,
                    data: chunkBytes.slice(headerSize + 8),
                    duration: duration
                });
            }
            self.postMessage({ type: mediaType + "chunk", clkms: Date.now(), captureClkms: captureClkms, seqId: seqId, chunk: chunk });
        }

        const reqLatencyMs = Date.now() - startTime;
        if (reqLatencyMs > (duration / 1000)) {
            sendMessageToMain(WORKER_PREFIX, "warning", "response: 200, Latency(ms): " + reqLatencyMs + ", Frame dur(ms): " + duration / 1000 + ". mediaType: " + mediaType + ", seqId: " + seqId + ", ts: " + timestamp);
        } else {
            sendMessageToMain(WORKER_PREFIX, "debug", "response: 200, Latency(ms): " + reqLatencyMs + ", Frame dur(ms): " + duration / 1000 + ". mediaType: " + mediaType + ", seqId:" + seqId + ", ts: " + timestamp);
        }

        return null;
    }
    catch (error) {
        sendMessageToMain(WORKER_PREFIX, "dropped stream", { clkms: Date.now(), seqId: -1, msg: "Dropped stream because WT error" });
        sendMessageToMain(WORKER_PREFIX, "error", "WT request. Err: " + error);

        return error;
    }
    finally {
        quicStreamsInFlight--;
    }
}