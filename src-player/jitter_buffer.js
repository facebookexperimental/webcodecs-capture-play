/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const DEFAULT_BUFFER_SIZE_MS = 200

class JitterBuffer {
    constructor(maxSizeMs, droppedCallback) {
        this.bufferSizeMs = DEFAULT_BUFFER_SIZE_MS;
        if (maxSizeMs !== undefined && maxSizeMs > 0) {
            this.bufferSizeMs = maxSizeMs;
        }
        this.elementsList = [];

        this.droppedCallback = droppedCallback;
        this.totalLengthMs = 0;
        this.numTotalGaps = 0;
        this.numTotalLostStreams = 0;
        this.lastCorrectSeqId = undefined;
    }

    AddItem(chunk, seqId, extraData) {
        let r = undefined
        // Order by SeqID
        if (this.elementsList.length <= 0) {
            this.elementsList.push({ chunk: chunk, seqId: seqId, extraData: extraData });
            this.totalLengthMs += chunk.duration / 1000;
        } else {
            if (seqId <= this.elementsList[0].seqId) {
                // Arrived late to jitter buffer -> drop
                if (this.droppedCallback != undefined) {
                    this.droppedCallback({ seqId: seqId, firstBufferSeqId: this.elementsList[0].seqId})
                }
            } else {
                let n = 0;
                let exit = false;
                while ((n < this.elementsList.length) && (!exit)) {
                    if (seqId < this.elementsList[n].seqId) {
                        this.elementsList.splice(n, 0, { chunk: chunk, seqId: seqId, extraData: extraData });
                        exit = true;
                    }
                    n++;
                }
                if (exit === false) {
                    this.elementsList.push({ chunk: chunk, seqId: seqId, extraData: extraData });
                }
                this.totalLengthMs += chunk.duration / 1000;
            }
        }
        
        // Get 1st element if jitter buffer full
        if (this.totalLengthMs >= this.bufferSizeMs) {
            r = this.elementsList.shift();

            // Check for discontinuities in the stream
            r.isDisco = false;
            r.repeatedOrBackwards = false;
            if (r.seqId >= 0) {// Init is -1
                if (this.lastCorrectSeqId != undefined) {
                    if (this.lastCorrectSeqId + 1 != r.seqId) {
                        r.isDisco = true;
                        this.numTotalGaps++;
                        this.numTotalLostStreams += (r.seqId - this.lastCorrectSeqId);

                        // Check for repeated and backwards seqID 
                        if (r.seqId <= this.lastCorrectSeqId) {
                            r.repeatedOrBackwards = true;
                        } else {
                            this.lastCorrectSeqId = r.seqId;
                        }
                    } else {
                        this.lastCorrectSeqId = r.seqId;
                    }
                } else {
                    this.lastCorrectSeqId = r.seqId;
                }
            }
            this.totalLengthMs -= r.chunk.duration / 1000;
        }
        return r;
    }

    GetStats() {
        return { numTotalGaps: this.numTotalGaps, numTotalLostStreams: this.numTotalLostStreams, totalLengthMs: this.totalLengthMs, size: this.elementsList.length };
    }

    Clear() {
        this.elementsList = [];
        this.totalLengthMs = 0;
        this.numTotalGaps = 0;
        this.numTotalLostStreams = 0;
        this.lastSeqIdDelivered = undefined;
    }
}