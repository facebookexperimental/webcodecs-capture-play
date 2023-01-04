const WORKER_PREFIX = "[DOWNLOADER]";

importScripts('utils.js');

let workerState = StateEnum.Created;

// Default values
let targetBufferS = 1;

// Requests expirations
let audioRequestExpirationS = 1
let videoRequestExpirationS = 1

// Requests timeout
const audioWaitAfterSuccessfulMs = 0
const audioWaitAfterErrorMs = 10
const videoWaitAfterSuccessfulMs = 0
const videoWaitAfterErrorMs = 20

let urlHostPort = "http://localhost:9094";
let urlPath = "streamid";

// Inflight req abort signal
const abortController = new AbortController();
const inFlightRequests = {
    'video': {},
    'audio': {}
}

// Signal disco between video <-> Audio
const isDiscoHappened = {
    'video': false,
    'audio': false
}

function addToInflight(mediaType, p) {
    ret = null;
    if (!(p.id in inFlightRequests[mediaType])) {
        inFlightRequests[mediaType][p.id] = p;
        ret = p.id;
    }
    reportStats();
    return ret;
}

function removeFromInflight(mediaType, id) {
    if (id in inFlightRequests[mediaType]) {
        delete inFlightRequests[mediaType][id];
    }
    reportStats();
}

function reportStats() {
    sendMessageToMain(WORKER_PREFIX, "downloaderstats", {clkms: Date.now(), audioInFlightRequests: getInflightRequestsLength(inFlightRequests['audio']), videoInFlightRequests: getInflightRequestsLength(inFlightRequests['video'])});
}

// Main listener
self.addEventListener('message', async function(e) {
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
            abortController.abort();
            await Promise.all(getAllInflightRequestsArray());
        } catch (err) {
            // Expected to finish some promises with abort error
            // The abort "errors" are already sent to main "thead" by sendMessageToMain inside the promise
        }

        isDiscoHappened['video'] = isDiscoHappened['audio'] = false;

    } else if (type == "forceedge") {
        if (workerState == StateEnum.Running) {
            isDiscoHappened['video'] = isDiscoHappened['audio'] = true;
        }

    } else if (type == "downloadersendini") {
        if (workerState !== StateEnum.Instantiated) {
            sendMessageToMain(WORKER_PREFIX, "error", "received ini message in wrong state. State: " + workerState);
            return;
        }

        if ('targetBufferS' in e.data.downloaderConfig) {
            targetBufferS = e.data.downloaderConfig.targetBufferS;
            audioRequestExpirationS = targetBufferS;
            videoRequestExpirationS = targetBufferS;
        }
        if ('urlHostPort' in e.data.downloaderConfig) {
            urlHostPort = e.data.downloaderConfig.urlHostPort;
        }
        if ('urlPath' in e.data.downloaderConfig) {
            urlPath = e.data.downloaderConfig.urlPath;
        }
        sendMessageToMain(WORKER_PREFIX, "info", "Initialized");

        workerState = StateEnum.Running;

        // Start downloading segments
        const streamBaseUrl = urlHostPort + "/" + urlPath;

        const audioInitUrl = streamBaseUrl + "/audio/init"
        const pInitAudio = fetch(audioInitUrl) 
        pInitAudio.then(response => {
            if (!response.ok) {
                throw new Error("HTTP error downloading audio init, status = " + response.status);
            }
            return response.arrayBuffer();
        })
        .then(initaData => {
            // Send init base
            self.postMessage({type: "initaudiochunk", clkms: Date.now(), data: initaData});
        })
        .catch(err => {
            sendMessageToMain(WORKER_PREFIX, "error", "error downloading init audio. err: " + err.message);
        })

        const videoInitUrl = streamBaseUrl + "/video/init"
        const pInitVideo = fetch(videoInitUrl) 
        pInitVideo.then(response => {
            if (!response.ok) {
                throw new Error("HTTP error downloading video init, status = " + response.status);
            }
            return response.arrayBuffer();
        })
        .then(initvData => {
            // Send init base
            self.postMessage({type: "initvideochunk", clkms: Date.now(), data: initvData});
        })
        .catch(err => {
            sendMessageToMain(WORKER_PREFIX, "error", "error downloading init video. err: " + err.message);
        })

        Promise.all([pInitVideo, pInitAudio])
        .then (results => {
            startDownloadChunks(streamBaseUrl, "audio", -1, audioWaitAfterSuccessfulMs, audioWaitAfterErrorMs, audioRequestExpirationS, targetBufferS);
            startDownloadChunks(streamBaseUrl, "video", -1, videoWaitAfterSuccessfulMs, videoWaitAfterErrorMs, videoRequestExpirationS, targetBufferS);
        })
        .catch(err => {
            sendMessageToMain(WORKER_PREFIX, "error", "error downloading init(s). err: " + err.message);
        });
    }
});

function getUrlSegmentStr(bufferTargetS) {
    if (bufferTargetS <= 0) {
        return "EDGE";
    } else {
        return `OLD_S=${bufferTargetS}`
    }
}
 
function startDownloadChunks(streamBaseUrl ,mediaType, seqId, waitAfterSuccessfulMs, waitAfterErrorMs, requestExpirationS, targetBufferS) {
    if (workerState === StateEnum.Stopped) {
        return
    }

    // If a gap happened in the other "thread", just force it here
    if (((mediaType == "video") && (isDiscoHappened['audio'])) || ((mediaType == "audio") && (isDiscoHappened['video'])) ) {
        isDiscoHappened['video'] = isDiscoHappened['audio'] = false;
        seqId = -1;
    }

    seqIdStr = seqId.toString();
    if (seqId < 0) {
        seqIdStr = getUrlSegmentStr(targetBufferS);
    }

    const pId = btoa(streamBaseUrl + "-" + mediaType + "-" + seqIdStr + "-"+ Math.floor(Math.random * 100000));
    
    const chunkUrl = streamBaseUrl + "/" + mediaType + "/" + seqIdStr;
    options = {
        method: 'GET',
        mode: 'cors',
        cache: 'default',
        headers: {'Expires': 'in=' + requestExpirationS},
    };

    // Add 20% to request expiration, this protects against bad player connection
    const rewTimeoutMs = Math.floor(requestExpirationS * 1200);
    const p = fetchWithTimeout(chunkUrl, options, rewTimeoutMs);
    p.id = pId;
    p.startTime = Date.now();
    
    if (addToInflight(mediaType, p) === null){
        sendMessageToMain(WORKER_PREFIX, "error", "id already exists in inflight, this should never happen. mediaType: " + mediaType + ", seqId: " + seqId);
    }

    let timestamp = -1;
    let type = "";
    let duration = -1;

    p.then(response => {
        removeFromInflight(mediaType, pId);
        if (response.ok) {
            // Get seq number of EDGE chunk
            if ((seqId < 0) && (response.headers.get('Joc-Seq-Id') !== null)) {
                seqId = parseInt(response.headers.get('Joc-Seq-Id'));
            }
            timestamp = parseInt(response.headers.get('Joc-Timestamp'));
            type = response.headers.get('Joc-Chunk-Type');
            duration = response.headers.get('Joc-Duration');
            
            const reqLatencyMs =  Date.now() - p.startTime;
            if (reqLatencyMs > (duration / 1000)) {
                sendMessageToMain(WORKER_PREFIX, "warning", "response: " + response.status + ", Latency(ms): " + reqLatencyMs + ", Frame dur(ms): " + duration / 1000 + ". For " + mediaType + "-" + seqId);
            } else {
                sendMessageToMain(WORKER_PREFIX, "debug", "response: " + response.status + ", Latency(ms): " + reqLatencyMs + ", Frame dur(ms): " + duration / 1000 + ". For " + mediaType + "-" + seqId);
            }
            
        } else {
            throw new Error("HTTP error, status = " + response.status);
        }
        return response.arrayBuffer();
    })
    .then(arrayBufferData => {
        if (mediaType === "audio") {
            chunk = new EncodedAudioChunk({
                timestamp: timestamp,
                type: type,
                data: arrayBufferData,
                duration: duration
            });
        } else if (mediaType === "video") {
            chunk = new EncodedVideoChunk({
                timestamp: timestamp,
                type: type,
                data: arrayBufferData,
                duration: duration
            });
        }
        self.postMessage({type: mediaType+"chunk", clkms: Date.now(), seqId: seqId, chunk: chunk});

        // This is sequential
        seqId++;
        setTimeout(startDownloadChunks, waitAfterSuccessfulMs, streamBaseUrl ,mediaType, seqId, waitAfterSuccessfulMs, waitAfterErrorMs, requestExpirationS, targetBufferS);
    })
    .catch(err => {
        removeFromInflight(mediaType, pId);

        if (err.name != 'AbortError') {
            sendMessageToMain(WORKER_PREFIX, "dropped", {clkms: Date.now(), seqId: seqId, msg: "Dropped " + mediaType + "chunk because request chunk error"});
            sendMessageToMain(WORKER_PREFIX, "error", "request: " + mediaType + "-" + seqId + ". Err: " + err.message);    
        }

        // On error defaults to ask for target buffer
        // We can download twice same data, but it will use browser cache if that is the case
        seqId = -1;
        isDiscoHappened[mediaType] = true;
        setTimeout(startDownloadChunks, waitAfterErrorMs, streamBaseUrl ,mediaType, seqId, waitAfterSuccessfulMs, waitAfterErrorMs, requestExpirationS, targetBufferS);
    });
}

function getInflightRequestsLength(inFlightRequestsType) {
    return Object.keys(inFlightRequestsType).length;
}

function getAllInflightRequestsArray() {
    const arrAudio = Object.values(inFlightRequests['audio']);
    const arrVideo = Object.values(inFlightRequests['video']);
    
    return arrAudio.concat(arrVideo)
}

function fetchWithTimeout(url, options, timeout) {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeout)
        )
    ]);
}