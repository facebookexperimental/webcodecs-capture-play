const WORKER_PREFIX = "[AUDIO-CAP]";

importScripts('utils.js');

let stopped = false;
let mainLoopInterval = undefined;
let isMainLoopInExecution = false;

function mainLoop(frameReader) {
    return new Promise(function(resolve, reject) {
        if (isMainLoopInExecution) {
            return resolve(false);
        }
        isMainLoopInExecution = true;
        if (stopped === true) {
            if (mainLoopInterval != undefined) {
                clearInterval(mainLoopInterval);
                mainLoopInterval = undefined;        
            }
            sendMessageToMain(WORKER_PREFIX, "info", "Exited!");
            isMainLoopInExecution = false;
            return resolve(false);
        }
        frameReader.read()
        .then(result => {
            if (result.done) {
                sendMessageToMain(WORKER_PREFIX, "info", "Stream is done");
                return frameReader.cancel("ended");
            } else {
                return new Promise(function(resolve, reject) { return resolve(result);});
            }
        }).then(result => {
            if (result === "ended") {
                isMainLoopInExecution = false;
                return resolve(false);
            } else {
                let aFrame = result.value;
                sendMessageToMain(WORKER_PREFIX, "debug", "Read frame format: " + aFrame.format + ", ts: " + aFrame.timestamp + "(" + aFrame.duration + "), fs: " + aFrame.sampleRate + ", Frames: " + aFrame.numberOfFrames + ", ch: " + aFrame.numberOfChannels);

                // AudioData is NOT transferable: https://github.com/WebAudio/web-audio-api/issues/2390
                self.postMessage({type: "aframe", clkms: Date.now(), data: aFrame.clone()});
                aFrame.close();

                isMainLoopInExecution = false;
                return resolve(true);
            }
        });
    });
}

self.addEventListener('message', async function(e) {
    var type = e.data.type;
    if (type == "stop") {
        stopped = true;
        return;
    }
    if (type == "stream") {
        if (mainLoopInterval != undefined) {
            sendMessageToMain(WORKER_PREFIX, "error", "Loop already running");
            return;
        }
        const aFrameStream = e.data.aStream;
        const aFrameReader = aFrameStream.getReader();

        sendMessageToMain(WORKER_PREFIX, "info", "Received streams from main page, starting worker loop");

        mainLoopInterval = setInterval(mainLoop, 1, aFrameReader);
        
        return;
    }
    
    sendMessageToMain(WORKER_PREFIX, "error", "Invalid message received");
    return;
});