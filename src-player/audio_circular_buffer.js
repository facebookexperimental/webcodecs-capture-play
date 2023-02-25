/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const SharedStates = {
    'AUDIO_BUFF_START': 0, // The reader only modifies this pointer
    'AUDIO_BUFF_END': 1, // The writer (this) only modifies this pointer

    'AUDIO_INSERTED_SILENCE_MS': 2,

    'IS_PLAYING' : 3, // Indicates playback state
};

class CicularAudioSharedBuffer {

    constructor() {
        this.sampleIndexToTS = null; // In Us
        this.sharedAudiobuffers = null;
        this.sharedCommBuffer = new SharedArrayBuffer(Object.keys(SharedStates).length * Int32Array.BYTES_PER_ELEMENT),
            this.size = -1;

        this.contextFrequency = -1;

        // Get TypedArrayView from SAB.
        this.sharedStates = new Int32Array(this.sharedCommBuffer);

        this.onDropped = null;
        
        // Initialize |States| buffer.
        Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, -1);
        Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, -1);
        Atomics.store(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS, 0);

        // Last sent timestamp
        this.lastTimestamp = undefined;
    }

    SetCallbacks(onDropped) {
        this.onDropped = onDropped;
    }

    Init(numChannels, numSamples, contextFrequency) {
        if (this.sharedAudiobuffers != null) {
            throw "Already initialized";
        }
        if ((numChannels <= 0) || (numChannels === undefined)) {
            throw "Passed bad numChannels";
        }
        if ((numSamples <= 0) || (numSamples === undefined)) {
            throw "Passed bad numSamples";
        }
        this.sharedAudiobuffers = [];
        for (let c = 0; c < numChannels; c++) {
            this.sharedAudiobuffers.push(new SharedArrayBuffer(numSamples * Float32Array.BYTES_PER_ELEMENT));
        }

        this.contextFrequency = contextFrequency;
        this.lastTimestamp = -1;

        this.size = numSamples;
        this.sampleIndexToTS = [];

        Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, 0);
        Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, 0);
    }

    Add(aFrame, overrideFrameTs) {
        const frameTimestamp = (overrideFrameTs === undefined) ? aFrame.timestamp : overrideFrameTs;
        if (aFrame === undefined) {
            throw "Passed undefined aFrame";
        }
        if (aFrame.numberOfChannels != this.sharedAudiobuffers.length) {
            throw `Channels diffent than expected, expected ${this.sharedAudiobuffers.length}, passed: ${aFrame.numberOfChannels}`;
        }
        if (aFrame.sampleRate != this.contextFrequency) {
            throw 'Error sampling frequency received does NOT match local audio rendered, needs more work :-): sampleFrequency: ' + this.sampleFrequency + ", contextSampleFrequency: " + this.contextSampleFrequency;
        }

        const samplesToAdd = aFrame.numberOfFrames;

        let start = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_START);
        let end = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_END);

        if (samplesToAdd > this._getFreeSlots(start, end)) {
            if (this.onDropped != null) {
                this.onDropped({ clkms: Date.now(), mediaType: "audio", ts: frameTimestamp, msg: "Dropped PCM audio frame, ring buffer full" });
            }
        } else {
            this.sampleIndexToTS.push({ sampleIndex: end, ts: frameTimestamp });
            if (end + samplesToAdd <= this.size) {
                // All
                for (let c = 0; c < aFrame.numberOfChannels; c++) {
                    const outputRingBuffer = new Float32Array(this.sharedAudiobuffers[c], end * Float32Array.BYTES_PER_ELEMENT);
                    aFrame.copyTo(outputRingBuffer, { planeIndex: c, frameOffset: 0, frameCount: samplesToAdd });
                }
                end += samplesToAdd;
            } else {
                const samplesToAddFirstHalf = this.size - end;
                const samplesToAddSecondsHalf = samplesToAdd - samplesToAddFirstHalf;
                for (let c = 0; c < aFrame.numberOfChannels; c++) {
                    // First half
                    const outputRingBuffer1 = new Float32Array(this.sharedAudiobuffers[c], end * Float32Array.BYTES_PER_ELEMENT, samplesToAddFirstHalf);
                    aFrame.copyTo(outputRingBuffer1, { planeIndex: c, frameOffset: 0, frameCount: samplesToAddFirstHalf });

                    // Seccond half
                    const outputRingBuffer2 = new Float32Array(this.sharedAudiobuffers[c], 0, samplesToAddSecondsHalf);
                    aFrame.copyTo(outputRingBuffer2, { planeIndex: c, frameOffset: samplesToAddFirstHalf, frameCount: samplesToAddSecondsHalf });
                }
                end = samplesToAddSecondsHalf;
            }
        }
        Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, end);
    }

    GetStats() {
        let start = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_START); // Reader
        let end = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_END); // Writer

        // Find the last sent timestamp
        let retIndexTs = undefined;
        let n = 0;
        let bExit = false;
        while (n < this.sampleIndexToTS.length && !bExit) {
            if (this._isSentSample(this.sampleIndexToTS[n].sampleIndex, start, end)) {
                retIndexTs = n;
            } else {
                if (retIndexTs != undefined) {
                    bExit = true;
                }
            }
            n++;
        }
        if (retIndexTs != undefined) {
            const lastFrameTimestampSent = this.sampleIndexToTS[retIndexTs].ts;
            const extraSamplesSent = start - this.sampleIndexToTS[retIndexTs].sampleIndex;

            // Adjust at sample level
            // Assume ts in nanosec
            this.lastTimestamp = lastFrameTimestampSent + (extraSamplesSent * 1000 * 1000)/this.contextFrequency;

            // Remove old indexes (already sent)
            this.sampleIndexToTS = this.sampleIndexToTS.slice(retIndexTs + 1);
        }

        const sizeSamples = this._getUsedSlots(start, end);
        const sizeMs = Math.floor((sizeSamples * 1000) / this.contextFrequency);
        const totalSilenceInsertedMs = Atomics.load(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS);
        const isPlaying =  Atomics.load(this.sharedStates, SharedStates.IS_PLAYING);

        return { currentTimestamp: this.lastTimestamp, queueSize: sizeSamples, queueLengthMs: sizeMs, totalSilenceInsertedMs: totalSilenceInsertedMs, isPlaying: isPlaying}
    }

    Play () {
        Atomics.store(this.sharedStates, SharedStates.IS_PLAYING, 1);
    }

    GetSharedBuffers() {
        if (this.sharedAudiobuffers === null) {
            throw "Not initialized yet";
        }
        return { sharedAudiobuffers: this.sharedAudiobuffers, sharedCommBuffer: this.sharedCommBuffer };
    }

    Clear() {
        this.sharedAudiobuffers = null;
        this.size = -1;
        this.sampleIndexToTS = null;
        this.contextFrequency = -1;
        this.lastTimestamp = undefined;

        Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, -1);
        Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, -1);
        Atomics.store(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS, 0);
        Atomics.store(this.sharedStates, SharedStates.IS_PLAYING, 0);
    }

    _getUsedSlots(start, end) {
        if (start === end) {
            return 0;
        } else if (end > start) {
            return end - start;
        } else {
            return (this.size - start) + end;
        }
    }

    _getFreeSlots(start, end) {
        return this.size - this._getUsedSlots(start, end);
    }

    _isSentSample(index, start, end) {
        if (start === end) {
            return false;
        } else if (end > start) {
            return index <= start;
        } else {
            return (index <= start && index > end);
        }
    }
}