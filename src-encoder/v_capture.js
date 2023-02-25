/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const WORKER_PREFIX = "[VIDEO-CAP]";

importScripts('utils.js');

let stopped = false;
let mainLoopInterval = undefined;
let isMainLoopInExecution = false;

let timeCheck = undefined;
let estFps = 0;

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
                let vFrame = result.value;
                
                sendMessageToMain(WORKER_PREFIX, "debug", "Read frame format: " + vFrame.format + ", ts: " + vFrame.timestamp + "(" + vFrame.duration + ")");
    
                // Send frame to process
                self.postMessage({type: "vframe", clkms: Date.now(), data: vFrame}, [vFrame]);
                //vFrame.close();

                estFps++;
                if (timeCheck == undefined) {
                    timeCheck = Date.now();
                }
                const nowMs = Date.now();
                if (nowMs >= timeCheck + 1000) {
                    sendMessageToMain(WORKER_PREFIX, "debug", "estimated fps last sec: " + estFps);
                    estFps = 0;
                    timeCheck = nowMs;
                }
                
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
        const vFrameStream = e.data.vStream;
        const vFrameReader = vFrameStream.getReader();

        sendMessageToMain(WORKER_PREFIX, "info", "Received streams from main page, starting worker loop");

        mainLoopInterval = setInterval(mainLoop, 1, vFrameReader);
        
        return;
    }
    
    sendMessageToMain(WORKER_PREFIX, "error", "Invalid message received.");
    return;
});